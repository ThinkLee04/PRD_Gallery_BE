import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Fail-fast, typed application configuration.
 *
 * The base build only consumes the keys needed to run the server. Google/R2
 * secrets are intentionally not validated here yet; their modules will add
 * their own validation when they land (see .env.example).
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

	const port = readInt("PORT", 3000);

	if (problems.length > 0) throw new ConfigError(problems);

	return {
		nodeEnv: isNodeEnv(nodeEnvRaw) ? nodeEnvRaw : "development",
		host: env.HOST ?? "127.0.0.1",
		port,
		corsOrigin,
		databaseUrl,
	};
}
