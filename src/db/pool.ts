import pg from "pg";
import type { AppConfig } from "../config.js";

const { Pool } = pg;

export type DatabaseStatus = "ok" | "unavailable" | "not_configured";

/**
 * Lazy process-wide pool, keyed off the boot configuration. The API never
 * connects at startup: liveness (/health) does not depend on the database and
 * readiness (/ready) reports the live status on demand.
 */
let cachedPool: pg.Pool | null | undefined;

export function createPoolFromUrl(databaseUrl: string): pg.Pool {
	// TLS is driven by the connection string (e.g. "?sslmode=require"). Modern
	// node-postgres parses sslmode into verified TLS (verify-full semantics), so
	// we do not override it here and never disable certificate verification.
	const pool = new Pool({
		connectionString: databaseUrl,
		max: 10,
		connectionTimeoutMillis: 5_000,
		query_timeout: 10_000,
		idleTimeoutMillis: 30_000,
	});

	// Prevent idle-client errors from crashing the process.
	pool.on("error", (err: Error) => {
		console.error("[pg] idle client error", err.message);
	});
	return pool;
}

export function getPool(config: AppConfig): pg.Pool | null {
	if (cachedPool === undefined) {
		cachedPool =
			config.databaseUrl !== null
				? createPoolFromUrl(config.databaseUrl)
				: null;
	}
	return cachedPool;
}

export async function closePool(): Promise<void> {
	if (cachedPool !== undefined && cachedPool !== null) {
		await cachedPool.end();
	}
	cachedPool = undefined;
}

/** Readiness check used by GET /ready. Never throws. */
export async function checkDatabase(
	config: AppConfig,
): Promise<DatabaseStatus> {
	const pool = getPool(config);
	if (pool === null) return "not_configured";
	try {
		await pool.query("SELECT 1");
		return "ok";
	} catch {
		return "unavailable";
	}
}
