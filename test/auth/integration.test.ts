import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../../src/app.js";
import type { AppConfig } from "../../src/config.js";
import { closePool, createPoolFromUrl, getPool } from "../../src/db/pool.js";
import { decryptLoginState } from "../../src/modules/auth/oauth.js";
import {
	createSession,
	findActiveUserByTokenHash,
	hashToken,
	newSessionToken,
	revokeSessionByTokenHash,
} from "../../src/modules/auth/session.js";
import { upsertGoogleUser } from "../../src/modules/users/service.js";
import { fakeGoogleFetch, signGoogleIdToken } from "./helpers.js";

// These tests need a real PostgreSQL. They self-skip unless DATABASE_URL is
// set (Vitest does not load be/.env automatically).
const DATABASE_URL = process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

const SESSION_SECRET = "integration-secret-0123456789abcdef0123456789";
const CLIENT_ID = "test-client-id";

function makeConfig(databaseUrl: string): AppConfig {
	return {
		nodeEnv: "test",
		host: "127.0.0.1",
		port: 0,
		corsOrigin: "http://localhost:5173",
		databaseUrl,
		appBaseUrl: "http://localhost:5173",
		googleClientId: CLIENT_ID,
		googleClientSecret: "test-client-secret",
		googleRedirectUri: "http://localhost:3000/auth/google/callback",
		sessionSecret: SESSION_SECRET,
		sessionTtlDays: 30,
		authRateLimitMax: 1_000_000,
		authRateLimitWindowSeconds: 60,
		adminEmails: [],
		vaultName: "Photo Vault",
		r2: null,
		r2UploadUrlTtlSeconds: 1800,
		r2DownloadUrlTtlSeconds: 600,
		maxImageUploadBytes: 104857600,
		maxVideoUploadBytes: 209715200,
	};
}

function cookieValue(
	setCookie: string | string[] | undefined,
	name: string,
): string | null {
	const headers = Array.isArray(setCookie)
		? setCookie
		: setCookie
			? [setCookie]
			: [];
	for (const header of headers) {
		const [pair] = header.split(";");
		if (pair === undefined) continue;
		const eq = pair.indexOf("=");
		if (eq > 0 && pair.slice(0, eq).trim() === name) {
			return pair.slice(eq + 1).trim();
		}
	}
	return null;
}

describeDb("auth integration (PostgreSQL)", () => {
	const dbUrl = DATABASE_URL as string;
	const config = makeConfig(dbUrl);
	const subject = `itest-${randomUUID()}`;
	const email = `${subject}@example.com`;
	let app: FastifyInstance;

	// The auth client captures `fetch` when the app is built (GoogleOAuth binds
	// its fetchFn at construction), so Google must be stubbed BEFORE buildApp.
	// The fake handler responds with whichever ID token the test has minted so
	// far; it is set after reading the login-state cookie's nonce below.
	let pendingIdToken = "";
	beforeAll(async () => {
		vi.stubGlobal("fetch", (input: string | URL | Request) =>
			fakeGoogleFetch(pendingIdToken)(input),
		);
		app = await buildApp(config);
	});

	afterAll(async () => {
		vi.unstubAllGlobals();
		const pool = getPool(config);
		if (pool !== null) {
			// sessions cascade on user delete; scope cleanup to our test subjects.
			await pool.query("DELETE FROM users WHERE google_subject = ANY($1)", [
				[subject, `${subject}-negative`],
			]);
		}
		await app?.close();
		await closePool();
	});

	it("completes a Google login end-to-end and revokes on logout", async () => {
		// 1. Start login -> state cookie (PKCE verifier + state + nonce).
		const start = await app.inject({ method: "GET", url: "/auth/google" });
		expect(start.statusCode).toBe(302);
		const stateCookie = cookieValue(
			start.headers["set-cookie"],
			"pv_oauth_state",
		);
		expect(stateCookie).toBeTruthy();
		const context = decryptLoginState(stateCookie as string, SESSION_SECRET);

		// 2. Stub Google and hit the callback with the matching state.
		const idToken = signGoogleIdToken({
			sub: subject,
			email,
			nonce: context.nonce,
			audience: CLIENT_ID,
			name: "Integration User",
			picture: "https://example.com/avatar.png",
		});
		pendingIdToken = idToken;

		const callback = await app.inject({
			method: "GET",
			url: `/auth/google/callback?code=fake-code&state=${context.state}`,
			headers: { cookie: `pv_oauth_state=${stateCookie}` },
		});
		expect(callback.statusCode).toBe(302);
		expect(String(callback.headers.location)).toBe(config.appBaseUrl);
		const sessionCookie = cookieValue(
			callback.headers["set-cookie"],
			"photo_vault_session",
		);
		expect(sessionCookie).toBeTruthy();

		// 3. Session works: /v1/me returns the upserted Google user.
		const me = await app.inject({
			method: "GET",
			url: "/v1/me",
			headers: { cookie: `photo_vault_session=${sessionCookie}` },
		});
		expect(me.statusCode).toBe(200);
		expect(me.json().data).toMatchObject({
			email,
			displayName: "Integration User",
			avatarUrl: "https://example.com/avatar.png",
		});
		expect(me.json().data.id).toBeTruthy();

		// 4. Logout revokes the session; /v1/me is then denied.
		const logout = await app.inject({
			method: "POST",
			url: "/auth/logout",
			headers: { cookie: `photo_vault_session=${sessionCookie}` },
		});
		expect(logout.statusCode).toBe(204);
		const denied = await app.inject({
			method: "GET",
			url: "/v1/me",
			headers: { cookie: `photo_vault_session=${sessionCookie}` },
		});
		expect(denied.statusCode).toBe(401);
		expect(denied.json().error.code).toBe("UNAUTHENTICATED");
	});

	it("denies a revoked session token (negative)", async () => {
		const pool = createPoolFromUrl(dbUrl);
		const negSubject = `${subject}-negative`;
		try {
			const user = await upsertGoogleUser(pool, {
				googleSubject: negSubject,
				email: `${negSubject}@example.com`,
				displayName: "Negative",
				avatarUrl: null,
			});
			const { token, tokenHash } = newSessionToken();
			await createSession(pool, { userId: user.id, tokenHash, ttlDays: 30 });

			// Active -> found.
			const active = await findActiveUserByTokenHash(pool, tokenHash);
			expect(active?.id).toBe(user.id);

			await revokeSessionByTokenHash(pool, tokenHash);
			// Revoked -> no user resolved (401 at the route boundary).
			expect(await findActiveUserByTokenHash(pool, tokenHash)).toBeNull();
			expect(hashToken(token)).toBe(tokenHash);
		} finally {
			await pool.end();
		}
	});
});
