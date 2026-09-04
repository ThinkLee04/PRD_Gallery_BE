import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { discoverMigrations, migrationName } from "../src/db/migrate.js";

const FIXTURES = fileURLToPath(
	new URL("./fixtures/migrations", import.meta.url),
);

describe("migration discovery", () => {
	it("discovers only timestamped .sql files in sorted order", async () => {
		const files = await discoverMigrations(FIXTURES);
		expect(files).toEqual(["001_first.sql", "002_second.sql"]);
	});

	it("strips the .sql extension from the migration name", () => {
		expect(migrationName("20260101_0000_create_users.sql")).toBe(
			"20260101_0000_create_users",
		);
	});
});
