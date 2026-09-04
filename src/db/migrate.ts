import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { loadConfig } from "../config.js";
import { createPoolFromUrl } from "./pool.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Directory containing timestamped *.sql migration files.
 * Source layout:  src/db/../../migrations
 * Compiled layout: dist/db/../../migrations  -> both resolve to <pkg>/migrations.
 */
export const MIGRATIONS_DIR = resolve(HERE, "../../migrations");

export function migrationName(file: string): string {
	return file.replace(/\.sql$/i, "");
}

/** Returns migration filenames (e.g. "001_create_users.sql") sorted lexicographically. */
export async function discoverMigrations(
	dir: string = MIGRATIONS_DIR,
): Promise<string[]> {
	const entries = await readdir(dir);
	return entries.filter((f) => /^\d+.*\.sql$/i.test(f)).sort();
}

export interface AppliedMigration {
	name: string;
	applied_at: string;
}

export async function appliedMigrations(pool: pg.Pool): Promise<Set<string>> {
	await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
	const result = await pool.query<AppliedMigration>(
		"SELECT name FROM schema_migrations",
	);
	return new Set(result.rows.map((r) => r.name));
}

export async function applyMigration(
	pool: pg.Pool,
	filename: string,
	dir: string,
): Promise<void> {
	const sql = await readFile(join(dir, filename), "utf8");
	const client = await pool.connect();
	try {
		await client.query("BEGIN");
		await client.query(sql);
		await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [
			migrationName(filename),
		]);
		await client.query("COMMIT");
	} catch (err) {
		await client.query("ROLLBACK").catch(() => undefined);
		throw err;
	} finally {
		client.release();
	}
}

/** Applies every pending migration in order and returns the count applied. */
export async function runMigrations(
	pool: pg.Pool,
	dir: string = MIGRATIONS_DIR,
): Promise<number> {
	const files = await discoverMigrations(dir);
	const done = await appliedMigrations(pool);
	let applied = 0;
	for (const file of files) {
		const name = migrationName(file);
		if (done.has(name)) continue;
		await applyMigration(pool, file, dir);
		applied += 1;
	}
	return applied;
}

async function main(): Promise<void> {
	const config = loadConfig();
	if (config.databaseUrl === null) {
		console.error("DATABASE_URL is required to run migrations.");
		process.exit(1);
	}
	const pool = createPoolFromUrl(config.databaseUrl);
	try {
		const applied = await runMigrations(pool);
		console.log(
			applied === 0
				? "No pending migrations."
				: `Applied ${applied} migration(s).`,
		);
	} catch (err) {
		console.error(
			"Migration failed:",
			err instanceof Error ? err.message : err,
		);
		process.exitCode = 1;
	} finally {
		await pool.end();
	}
}

if (
	process.argv[1] &&
	fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
	void main();
}
