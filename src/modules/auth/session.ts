import { createHash, randomBytes } from "node:crypto";
import type { CookieSerializeOptions } from "@fastify/cookie";
import type { FastifyRequest } from "fastify";
import type pg from "pg";
import type { AppConfig } from "../../config.js";
import { getPool } from "../../db/pool.js";
import { ApiError, ErrorCodes } from "../../lib/errors.js";

/**
 * Opaque, server-stored sessions (spec §7). The browser holds only a random
 * token in a Secure/HttpOnly cookie; the database stores its SHA-256 hash.
 */

export const SESSION_COOKIE_NAME = "photo_vault_session";
export const OAUTH_STATE_COOKIE_NAME = "pv_oauth_state";
const SESSION_COOKIE_PATH = "/";
const OAUTH_STATE_COOKIE_PATH = "/auth";

export interface SessionUser {
	id: string;
	email: string;
	displayName: string;
	avatarUrl: string | null;
}

/** Cookie flags shared by session and OAuth-state cookies. */
export function baseCookieOptions(
	config: AppConfig,
	path: string,
): CookieSerializeOptions {
	return {
		httpOnly: true,
		sameSite: "lax",
		secure: config.nodeEnv === "production",
		path,
	};
}

export function sessionCookieOptions(
	config: AppConfig,
	maxAgeSeconds: number,
): CookieSerializeOptions {
	return {
		...baseCookieOptions(config, SESSION_COOKIE_PATH),
		maxAge: maxAgeSeconds,
	};
}

export function oauthStateCookieOptions(
	config: AppConfig,
): CookieSerializeOptions {
	return {
		...baseCookieOptions(config, OAUTH_STATE_COOKIE_PATH),
		maxAge: 10 * 60, // 10 minutes: long enough for the Google round trip.
	};
}

export function clearCookieOptions(
	config: AppConfig,
	path: string,
): CookieSerializeOptions {
	return { ...baseCookieOptions(config, path) };
}

/** Generates a fresh opaque session token and its stored SHA-256 hash. */
export function newSessionToken(): { token: string; tokenHash: string } {
	const token = randomBytes(32).toString("base64url");
	return { token, tokenHash: hashToken(token) };
}

export function hashToken(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

export function readSessionToken(request: FastifyRequest): string | null {
	const raw = request.cookies?.[SESSION_COOKIE_NAME];
	return raw !== undefined && raw !== "" ? raw : null;
}

export interface CreateSessionInput {
	userId: string;
	tokenHash: string;
	ttlDays: number;
}

export async function createSession(
	pool: pg.Pool,
	input: CreateSessionInput,
): Promise<void> {
	await pool.query(
		`INSERT INTO sessions (user_id, token_hash, expires_at, last_seen_at)
		 VALUES ($1, $2, now() + make_interval(days => $3), now())`,
		[input.userId, input.tokenHash, input.ttlDays],
	);
}

export async function revokeSessionByTokenHash(
	pool: pg.Pool,
	tokenHash: string,
): Promise<void> {
	await pool.query(
		"UPDATE sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL",
		[tokenHash],
	);
}

interface SessionUserRow {
	id: string;
	email: string;
	displayName: string;
	avatarUrl: string | null;
	sessionId: string;
}

/**
 * Looks up the active user for a session token hash. Returns null when the
 * session is missing, revoked, or expired. Refreshes `last_seen_at` at most
 * every 5 minutes to avoid a write per request.
 */
export async function findActiveUserByTokenHash(
	pool: pg.Pool,
	tokenHash: string,
): Promise<SessionUser | null> {
	const result = await pool.query<SessionUserRow>(
		`SELECT u.id,
		        u.email,
		        u.display_name AS "displayName",
		        u.avatar_url AS "avatarUrl",
		        s.id AS "sessionId"
		   FROM sessions s
		   JOIN users u ON u.id = s.user_id
		  WHERE s.token_hash = $1
		    AND s.revoked_at IS NULL
		    AND s.expires_at > now()`,
		[tokenHash],
	);
	const row = result.rows[0];
	if (row === undefined) return null;
	await pool.query(
		`UPDATE sessions
		    SET last_seen_at = now()
		  WHERE id = $1
		    AND (last_seen_at IS NULL OR last_seen_at < now() - interval '5 minutes')`,
		[row.sessionId],
	);
	return {
		id: row.id,
		email: row.email,
		displayName: row.displayName,
		avatarUrl: row.avatarUrl,
	};
}

/**
 * Resolves the current authenticated user from the session cookie or throws
 * UNAUTHENTICATED. Every protected route starts with this guard; authorization
 * beyond "logged in" (vault membership) is enforced later by each module.
 */
export async function requireUser(
	request: FastifyRequest,
	config: AppConfig,
): Promise<SessionUser> {
	const token = readSessionToken(request);
	if (token === null) {
		throw new ApiError(ErrorCodes.UNAUTHENTICATED, "Authentication required.");
	}
	const pool = getPool(config);
	if (pool === null) {
		throw new ApiError(
			ErrorCodes.INTERNAL_ERROR,
			"Authentication is unavailable.",
		);
	}
	const user = await findActiveUserByTokenHash(pool, hashToken(token));
	if (user === null) {
		throw new ApiError(ErrorCodes.UNAUTHENTICATED, "Authentication required.");
	}
	return user;
}
