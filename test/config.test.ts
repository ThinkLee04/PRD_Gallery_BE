import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.js";

const FIXTURE_DIR = fileURLToPath(new URL("./fixtures", import.meta.url));

function env(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
	return { ...overrides };
}

describe("loadConfig", () => {
	it("applies safe defaults for an empty environment", () => {
		const config = loadConfig(env(), FIXTURE_DIR);
		expect(config).toMatchObject({
			nodeEnv: "development",
			host: "127.0.0.1",
			port: 3000,
			corsOrigin: "http://localhost:5173",
			databaseUrl: null,
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
});
