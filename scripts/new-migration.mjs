// Creates a new timestamped SQL migration file under ./migrations.
// Usage: node scripts/new-migration.mjs <name>
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const name = process.argv[2];
if (!name || !/^[a-z0-9_]+$/.test(name)) {
	console.error("Usage: node scripts/new-migration.mjs <snake_case_name>");
	process.exit(1);
}

const stamp = new Date()
	.toISOString()
	.replace(/[-:.TZ]/g, "")
	.slice(0, 14);
const filename = `${stamp}_${name}.sql`;
const migrationsDir = join(root, "migrations");
mkdirSync(migrationsDir, { recursive: true });
writeFileSync(
	join(migrationsDir, filename),
	`-- Up migration: ${name}\n\n\n-- Down migration:\n`,
);
console.log(`Created ${join("migrations", filename)}`);
