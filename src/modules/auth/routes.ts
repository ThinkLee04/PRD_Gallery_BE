import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AppConfig } from "../../config.js";
import { getPool } from "../../db/pool.js";
import { bootstrapUserAccess } from "../memberships/service.js";
import { upsertGoogleUser } from "../users/service.js";
import {
	createLoginContext,
	decryptLoginState,
	encryptLoginState,
	GoogleOAuth,
	type LoginContext,
} from "./oauth.js";
import { createRateLimitHook } from "./rate-limit.js";
import { MeResponseSchema } from "./schemas.js";
import {
	clearCookieOptions,
	createSession,
	hashToken,
	newSessionToken,
	OAUTH_STATE_COOKIE_NAME,
	oauthStateCookieOptions,
	readSessionToken,
	requireUser,
	revokeSessionByTokenHash,
	SESSION_COOKIE_NAME,
	sessionCookieOptions,
} from "./session.js";

interface CallbackQuery {
	code?: string;
	state?: string;
	error?: string;
}

/**
 * Google-only auth (spec §7/§9):
 *   GET /auth/google         start login (PKCE + state + nonce), redirect to Google
 *   GET /auth/google/callback verify response, upsert user, mint session cookie
 *   GET /v1/me               current authenticated user
 *   POST /auth/logout        revoke the current session
 */
export async function registerAuthModule(
	app: FastifyInstance,
	config: AppConfig,
): Promise<void> {
	const oauth = new GoogleOAuth({
		clientId: config.googleClientId,
		clientSecret: config.googleClientSecret,
		redirectUri: config.googleRedirectUri,
	});
	const rateLimit = createRateLimitHook({
		max: config.authRateLimitMax,
		windowMs: config.authRateLimitWindowSeconds * 1000,
	});

	/** Redirects the browser to the SPA with a non-secret error param. */
	const redirectWithError = (
		request: FastifyRequest,
		error: string,
	): string => {
		const url = new URL(config.appBaseUrl);
		url.searchParams.set("error", error);
		request.log.info({ error }, "google auth failed");
		return url.toString();
	};

	app.get(
		"/auth/google",
		{ preHandler: rateLimit },
		async (_request, reply) => {
			const context = createLoginContext();
			reply.setCookie(
				OAUTH_STATE_COOKIE_NAME,
				encryptLoginState(context, config.sessionSecret),
				oauthStateCookieOptions(config),
			);
			return reply.redirect(oauth.buildAuthorizeUrl(context));
		},
	);

	app.get(
		"/auth/google/callback",
		{ preHandler: rateLimit },
		async (request, reply) => {
			const query = request.query as CallbackQuery;
			const fail = (error: string) => {
				reply.clearCookie(
					OAUTH_STATE_COOKIE_NAME,
					clearCookieOptions(config, "/auth"),
				);
				return reply.redirect(redirectWithError(request, error));
			};

			// Google denies the request with ?error=...; surface it to the SPA.
			if (query.error !== undefined) {
				return fail(query.error === "" ? "access_denied" : query.error);
			}
			const { code, state } = query;
			const stateCookie = request.cookies?.[OAUTH_STATE_COOKIE_NAME];
			if (
				typeof code !== "string" ||
				code === "" ||
				typeof state !== "string" ||
				stateCookie === undefined
			) {
				return fail("auth_failed");
			}

			let context: LoginContext;
			try {
				context = decryptLoginState(stateCookie, config.sessionSecret);
			} catch {
				return fail("auth_failed");
			}
			if (context.state !== state) {
				return fail("auth_failed");
			}

			try {
				const { idToken } = await oauth.exchangeCodeForTokens(
					code,
					context.codeVerifier,
				);
				const profile = await oauth.verifyIdToken(idToken, context.nonce);
				const pool = getPool(config);
				if (pool === null) {
					throw new Error("DATABASE_URL is not configured.");
				}
				const user = await upsertGoogleUser(pool, profile);
				await bootstrapUserAccess(pool, {
					userId: user.id,
					email: user.email,
					adminEmails: config.adminEmails,
					vaultName: config.vaultName,
				});

				const { token, tokenHash } = newSessionToken();
				await createSession(pool, {
					userId: user.id,
					tokenHash,
					ttlDays: config.sessionTtlDays,
				});

				reply.clearCookie(
					OAUTH_STATE_COOKIE_NAME,
					clearCookieOptions(config, "/auth"),
				);
				reply.setCookie(
					SESSION_COOKIE_NAME,
					token,
					sessionCookieOptions(config, config.sessionTtlDays * 86_400),
				);
				return reply.redirect(config.appBaseUrl);
			} catch (err) {
				request.log.warn({ err }, "google auth callback failed");
				return fail("auth_failed");
			}
		},
	);

	app.get(
		"/v1/me",
		{ schema: { response: { 200: MeResponseSchema } } },
		async (request) => {
			let user = await requireUser(request, config);
			if (
				config.adminEmails.includes(user.email.toLowerCase()) &&
				(!user.isAdmin || user.approvalStatus !== "APPROVED")
			) {
				const pool = getPool(config);
				if (pool !== null) {
					await bootstrapUserAccess(pool, {
						userId: user.id,
						email: user.email,
						adminEmails: config.adminEmails,
						vaultName: config.vaultName,
					});
					user = await requireUser(request, config);
				}
			}
			return {
				data: {
					id: user.id,
					email: user.email,
					displayName: user.displayName,
					avatarUrl: user.avatarUrl,
					approvalStatus: user.approvalStatus,
					isAdmin: user.isAdmin,
					vault:
						user.vaultId === null ||
						user.vaultRole === null ||
						user.vaultName === null
							? null
							: {
									id: user.vaultId,
									name: user.vaultName,
									role: user.vaultRole,
								},
				},
			};
		},
	);

	app.post("/auth/logout", async (request, reply) => {
		const token = readSessionToken(request);
		if (token !== null) {
			const pool = getPool(config);
			if (pool !== null) {
				await revokeSessionByTokenHash(pool, hashToken(token));
			}
		}
		reply.clearCookie(SESSION_COOKIE_NAME, clearCookieOptions(config, "/"));
		return reply.code(204).send();
	});
}
