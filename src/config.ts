import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Fail-fast, typed application configuration.
 *
 * Google OAuth keys and the session secret are required at boot (spec §13):
 * without them the auth module cannot start. R2 secrets are still reserved for
 * the uploads module and are validated there when it lands (see .env.example).
 */

export type NodeEnv = "development" | "test" | "production";

export interface AppConfig {
	nodeEnv: NodeEnv;
	host: string;
	port: number;
	/** Browser origin allowed to call the API (narrow CORS; never "*"). */
	corsOrigin: string;
	/**
	 * PostgreSQL connection string. Optional at boot so the API can start and
	 * serve /health without a database (liveness). `migrate` and /ready treat a
	 * missing value as an error / "not configured" respectively.
	 */
	databaseUrl: string | null;
	/** Browser base URL; OAuth callbacks redirect here after login. */
	appBaseUrl: string;
	/** Google OAuth 2.0 "Web application" client credentials. */
	googleClientId: string;
	googleClientSecret: string;
	/** Must be registered as an authorized redirect URI in Google Cloud. */
	googleRedirectUri: string;
	/**
	 * High-entropy server secret used to encrypt the short-lived OAuth
	 * login-state cookie (PKCE verifier/state/nonce). Not the session token.
	 */
	sessionSecret: string;
	/** Session cookie lifetime in days (default 30). */
	sessionTtlDays: number;
	/** In-memory per-IP rate limit for the OAuth endpoints. */
	authRateLimitMax: number;
	authRateLimitWindowSeconds: number;
}

export class ConfigError extends Error {
	readonly problems: string[];
	constructor(problems: string[]) {
		super(`Invalid environment configuration:\n- ${problems.join("\n- ")}`);
		this.name = "ConfigError";
		this.problems = problems;
	}
}

const NODE_ENVS: readonly NodeEnv[] = ["development", "test", "production"];

/** Very small .env loader; does not overwrite already-set environment variables. */
function loadDotEnvIfPresent(cwd: string): void {
	const envPath = resolve(cwd, ".env");
	if (!existsSync(envPath)) return;
	const raw = readFileSync(envPath, "utf8");
	for (const line of raw.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (trimmed === "" || trimmed.startsWith("#")) continue;
		const eq = trimmed.indexOf("=");
		if (eq <= 0) continue;
		const key = trimmed.slice(0, eq).trim();
		let value = trimmed.slice(eq + 1).trim();
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}
		if (key !== "" && process.env[key] === undefined) process.env[key] = value;
	}
}

function isNodeEnv(value: string | undefined): value is NodeEnv {
	return NODE_ENVS.includes(value as NodeEnv);
}

export function loadConfig(
	env: NodeJS.ProcessEnv = process.env,
	cwd: string = process.cwd(),
): AppConfig {
	loadDotEnvIfPresent(cwd);

	const problems: string[] = [];
	const readInt = (name: string, fallback: number): number => {
		const raw = env[name];
		if (raw === undefined || raw === "") return fallback;
		const parsed = Number.parseInt(raw, 10);
		if (
			Number.isNaN(parsed) ||
			!Number.isInteger(parsed) ||
			parsed < 0 ||
			parsed > 65535
		) {
			problems.push(
				`${name} must be an integer between 0 and 65535 (got "${raw}").`,
			);
			return fallback;
		}
		return parsed;
	};

	/** Required auth config value; collects a non-secret problem when missing. */
	const requireValue = (name: string): string => {
		const value = (env[name] ?? "").trim();
		if (value === "") {
			problems.push(`${name} is required.`);
			return "";
		}
		return value;
	};

	const isHttpUrl = (value: string): boolean => {
		try {
			const url = new URL(value);
			return url.protocol === "http:" || url.protocol === "https:";
		} catch {
			return false;
		}
	};

	const nodeEnvRaw = env.NODE_ENV ?? "development";
	if (!isNodeEnv(nodeEnvRaw)) {
		problems.push(
			`NODE_ENV must be one of ${NODE_ENVS.join(", ")} (got "${nodeEnvRaw}").`,
		);
	}

	const databaseUrl =
		env.DATABASE_URL && env.DATABASE_URL !== "" ? env.DATABASE_URL : null;
	if (databaseUrl !== null && !/^postgres(ql)?:\/\//.test(databaseUrl)) {
		problems.push("DATABASE_URL must start with postgresql:// or postgres://.");
	}

	const corsOrigin = env.CORS_ORIGIN ?? "http://localhost:5173";
	if (corsOrigin === "*") {
		problems.push('CORS_ORIGIN must not be "*" when credentials are used.');
	}

	// Auth module configuration (spec §7/§13). Required at boot.
	const appBaseUrl = requireValue("APP_BASE_URL");
	if (appBaseUrl !== "" && !isHttpUrl(appBaseUrl)) {
		problems.push("APP_BASE_URL must be an absolute http(s) URL.");
	}
	const googleRedirectUri = requireValue("GOOGLE_REDIRECT_URI");
	if (googleRedirectUri !== "" && !isHttpUrl(googleRedirectUri)) {
		problems.push("GOOGLE_REDIRECT_URI must be an absolute http(s) URL.");
	}
	const googleClientId = requireValue("GOOGLE_CLIENT_ID");
	const googleClientSecret = requireValue("GOOGLE_CLIENT_SECRET");
	const sessionSecret = requireValue("SESSION_SECRET");
	if (sessionSecret !== "" && sessionSecret.length < 32) {
		problems.push("SESSION_SECRET must be at least 32 characters long.");
	}

	const port = readInt("PORT", 3000);
	const sessionTtlDays = readInt("SESSION_TTL_DAYS", 30);
	const authRateLimitMax = readInt("AUTH_RATE_LIMIT_MAX", 30);
	const authRateLimitWindowSeconds = readInt(
		"AUTH_RATE_LIMIT_WINDOW_SECONDS",
		60,
	);

	if (problems.length > 0) throw new ConfigError(problems);

	return {
		nodeEnv: isNodeEnv(nodeEnvRaw) ? nodeEnvRaw : "development",
		host: env.HOST ?? "127.0.0.1",
		port,
		corsOrigin,
		databaseUrl,
		appBaseUrl,
		googleClientId,
		googleClientSecret,
		googleRedirectUri,
		sessionSecret,
		sessionTtlDays,
		authRateLimitMax,
		authRateLimitWindowSeconds,
	};
}
