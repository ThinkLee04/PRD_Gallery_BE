import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.js";

const FIXTURE_DIR = fileURLToPath(new URL("./fixtures", import.meta.url));

function env(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
	return { ...overrides };
}

describe("loadConfig", () => {
	it("fails fast when required auth configuration is missing", () => {
		const run = () => loadConfig(env(), FIXTURE_DIR);
		expect(run).toThrow(ConfigError);
		expect(run).toThrow(/APP_BASE_URL/);
		expect(run).toThrow(/GOOGLE_CLIENT_ID/);
		expect(run).toThrow(/GOOGLE_CLIENT_SECRET/);
		expect(run).toThrow(/GOOGLE_REDIRECT_URI/);
		expect(run).toThrow(/SESSION_SECRET/);
	});

	it("applies safe defaults for a fully specified environment", () => {
		const config = loadConfig(
			env({
				APP_BASE_URL: "http://localhost:5173",
				GOOGLE_CLIENT_ID: "client-id",
				GOOGLE_CLIENT_SECRET: "client-secret",
				GOOGLE_REDIRECT_URI: "http://localhost:3000/auth/google/callback",
				SESSION_SECRET: "0123456789abcdef0123456789abcdef0123456789",
			}),
			FIXTURE_DIR,
		);
		expect(config).toMatchObject({
			nodeEnv: "development",
			host: "127.0.0.1",
			port: 3000,
			corsOrigin: "http://localhost:5173",
			databaseUrl: null,
			appBaseUrl: "http://localhost:5173",
			googleClientId: "client-id",
			googleClientSecret: "client-secret",
			googleRedirectUri: "http://localhost:3000/auth/google/callback",
			sessionSecret: "0123456789abcdef0123456789abcdef0123456789",
			sessionTtlDays: 30,
			authRateLimitMax: 30,
			authRateLimitWindowSeconds: 60,
			uploadRateLimitMax: 300,
			uploadRateLimitWindowSeconds: 60,
		});
	});

	it("parses a fully specified valid environment", () => {
		const config = loadConfig(
			env({
				NODE_ENV: "production",
				HOST: "127.0.0.1",
				PORT: "4000",
				CORS_ORIGIN: "https://photos.example.com",
				DATABASE_URL:
					"postgresql://user:pass@db.example.com:5432/vault?sslmode=require",
				APP_BASE_URL: "https://photos.example.com",
				GOOGLE_CLIENT_ID: "google-client-id",
				GOOGLE_CLIENT_SECRET: "google-client-secret",
				GOOGLE_REDIRECT_URI: "https://photos.example.com/auth/google/callback",
				SESSION_SECRET: "0123456789abcdef0123456789abcdef0123456789",
				SESSION_TTL_DAYS: "14",
				AUTH_RATE_LIMIT_MAX: "5",
				AUTH_RATE_LIMIT_WINDOW_SECONDS: "30",
				UPLOAD_RATE_LIMIT_MAX: "450",
				UPLOAD_RATE_LIMIT_WINDOW_SECONDS: "90",
				APP_ADMIN_EMAILS: "admin@example.com",
				SINGLE_VAULT_NAME: "Friends",
				R2_ENDPOINT: "https://account.r2.cloudflarestorage.com",
				R2_ACCESS_KEY_ID: "access",
				R2_SECRET_ACCESS_KEY: "secret",
				R2_BUCKET_NAME: "photos",
			}),
			FIXTURE_DIR,
		);
		expect(config).toEqual({
			nodeEnv: "production",
			host: "127.0.0.1",
			port: 4000,
			corsOrigin: "https://photos.example.com",
			databaseUrl:
				"postgresql://user:pass@db.example.com:5432/vault?sslmode=require",
			appBaseUrl: "https://photos.example.com",
			googleClientId: "google-client-id",
			googleClientSecret: "google-client-secret",
			googleRedirectUri: "https://photos.example.com/auth/google/callback",
			sessionSecret: "0123456789abcdef0123456789abcdef0123456789",
			sessionTtlDays: 14,
			authRateLimitMax: 5,
			authRateLimitWindowSeconds: 30,
			uploadRateLimitMax: 450,
			uploadRateLimitWindowSeconds: 90,
			adminEmails: ["admin@example.com"],
			vaultName: "Friends",
			r2: {
				endpoint: "https://account.r2.cloudflarestorage.com",
				accessKeyId: "access",
				secretAccessKey: "secret",
				bucket: "photos",
			},
			r2UploadUrlTtlSeconds: 1800,
			r2DownloadUrlTtlSeconds: 600,
			maxImageUploadBytes: 104857600,
			maxVideoUploadBytes: 209715200,
		});
	});

	it("rejects an unknown NODE_ENV", () => {
		expect(() => loadConfig(env({ NODE_ENV: "staging" }), FIXTURE_DIR)).toThrow(
			ConfigError,
		);
	});

	it("rejects a non-numeric or out-of-range PORT", () => {
		expect(() => loadConfig(env({ PORT: "abc" }), FIXTURE_DIR)).toThrow(/PORT/);
		expect(() => loadConfig(env({ PORT: "70000" }), FIXTURE_DIR)).toThrow(
			/PORT/,
		);
	});

	it("rejects a DATABASE_URL that is not postgres", () => {
		expect(() =>
			loadConfig(
				env({ DATABASE_URL: "mysql://user:pass@host/db" }),
				FIXTURE_DIR,
			),
		).toThrow(/DATABASE_URL/);
	});

	it("rejects a wildcard CORS origin", () => {
		expect(() => loadConfig(env({ CORS_ORIGIN: "*" }), FIXTURE_DIR)).toThrow(
			/CORS_ORIGIN/,
		);
	});

	it("rejects a non-http APP_BASE_URL or GOOGLE_REDIRECT_URI", () => {
		const base = {
			APP_BASE_URL: "http://localhost:5173",
			GOOGLE_CLIENT_ID: "id",
			GOOGLE_CLIENT_SECRET: "secret",
			GOOGLE_REDIRECT_URI: "http://localhost:3000/auth/google/callback",
			SESSION_SECRET: "0123456789abcdef0123456789abcdef0123456789",
		};
		expect(() =>
			loadConfig(env({ ...base, APP_BASE_URL: "not a url" }), FIXTURE_DIR),
		).toThrow(/APP_BASE_URL/);
		expect(() =>
			loadConfig(
				env({ ...base, GOOGLE_REDIRECT_URI: "ftp://example.com/cb" }),
				FIXTURE_DIR,
			),
		).toThrow(/GOOGLE_REDIRECT_URI/);
	});

	it("rejects a short SESSION_SECRET", () => {
		expect(() =>
			loadConfig(
				env({
					APP_BASE_URL: "http://localhost:5173",
					GOOGLE_CLIENT_ID: "id",
					GOOGLE_CLIENT_SECRET: "secret",
					GOOGLE_REDIRECT_URI: "http://localhost:3000/auth/google/callback",
					SESSION_SECRET: "way-too-short",
				}),
				FIXTURE_DIR,
			),
		).toThrow(/SESSION_SECRET/);
	});
});
