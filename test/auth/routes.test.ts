import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import type { AppConfig } from "../../src/config.js";
import { closePool } from "../../src/db/pool.js";

const TEST_CONFIG: AppConfig = {
	nodeEnv: "test",
	host: "127.0.0.1",
	port: 0,
	corsOrigin: "http://localhost:5173",
	databaseUrl: null, // no database -> unauthenticated paths only are exercised
	appBaseUrl: "http://localhost:5173",
	googleClientId: "test-client-id",
	googleClientSecret: "test-client-secret",
	googleRedirectUri: "http://localhost:3000/auth/google/callback",
	sessionSecret: "test-session-secret-0123456789abcdef0123456789abcdef",
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

describe("auth routes (no database)", () => {
	let app: FastifyInstance;

	afterEach(async () => {
		await app?.close();
		await closePool();
	});

	it("GET /auth/google redirects to Google with PKCE and sets the state cookie", async () => {
		app = await buildApp(TEST_CONFIG);
		const res = await app.inject({ method: "GET", url: "/auth/google" });
		expect(res.statusCode).toBe(302);
		const location = res.headers.location as string;
		expect(location).toMatch(
			/^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth/,
		);
		const url = new URL(location);
		expect(url.searchParams.get("response_type")).toBe("code");
		expect(url.searchParams.get("scope")).toBe("openid email profile");
		expect(url.searchParams.get("code_challenge_method")).toBe("S256");
		expect(url.searchParams.get("code_challenge")).toBeTruthy();
		expect(url.searchParams.get("state")).toBeTruthy();
		expect(url.searchParams.get("nonce")).toBeTruthy();
		expect(
			cookieValue(res.headers["set-cookie"], "pv_oauth_state"),
		).toBeTruthy();
	});

	it("GET /v1/me without a session returns 401 UNAUTHENTICATED", async () => {
		app = await buildApp(TEST_CONFIG);
		const res = await app.inject({ method: "GET", url: "/v1/me" });
		expect(res.statusCode).toBe(401);
		expect(res.json()).toMatchObject({
			error: { code: "UNAUTHENTICATED" },
		});
	});

	it("GET /auth/google/callback without a state cookie redirects with an error", async () => {
		app = await buildApp(TEST_CONFIG);
		const res = await app.inject({
			method: "GET",
			url: "/auth/google/callback?code=fake&state=whatever",
		});
		expect(res.statusCode).toBe(302);
		const location = new URL(res.headers.location as string);
		expect(location.origin).toBe("http://localhost:5173");
		expect(location.searchParams.get("error")).toBe("auth_failed");
	});

	it("GET /auth/google/callback surfaces Google denial via the error param", async () => {
		app = await buildApp(TEST_CONFIG);
		const res = await app.inject({
			method: "GET",
			url: "/auth/google/callback?error=access_denied&state=x",
		});
		expect(res.statusCode).toBe(302);
		const location = new URL(res.headers.location as string);
		expect(location.searchParams.get("error")).toBe("access_denied");
	});

	it("POST /auth/logout is idempotent and returns 204 without a session", async () => {
		app = await buildApp(TEST_CONFIG);
		const res = await app.inject({ method: "POST", url: "/auth/logout" });
		expect(res.statusCode).toBe(204);
	});
});
