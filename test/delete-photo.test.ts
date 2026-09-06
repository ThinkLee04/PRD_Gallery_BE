import type pg from "pg";
import { describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config.js";
import { permanentlyDeletePhoto } from "../src/modules/photos/delete-photo.js";

function fakePool(
	photo: { id: string; originalObjectKey: string } | undefined,
	assetKeys: string[] = [],
) {
	const queries: string[] = [];
	const query = vi.fn(async (sql: string) => {
		queries.push(sql);
		if (sql.includes("FROM photos p")) return { rows: photo ? [photo] : [] };
		if (sql.includes("FROM photo_assets"))
			return { rows: assetKeys.map((objectKey) => ({ objectKey })) };
		return { rows: [] };
	});
	const release = vi.fn();
	return {
		pool: {
			connect: vi.fn(async () => ({ query, release })),
		} as unknown as pg.Pool,
		queries,
		release,
	};
}

const config = { nodeEnv: "test" } as AppConfig;

describe("permanent photo deletion", () => {
	it("deletes every stored object before deleting the cascading photo row", async () => {
		const database = fakePool(
			{ id: "photo-id", originalObjectKey: "original" },
			["thumb-sm", "thumb-md", "display"],
		);
		const removeObjects = vi.fn(async () => undefined);

		await expect(
			permanentlyDeletePhoto(
				database.pool,
				config,
				"vault-id",
				"photo-id",
				removeObjects,
			),
		).resolves.toBe(true);
		expect(removeObjects).toHaveBeenCalledWith(config, [
			"original",
			"thumb-sm",
			"thumb-md",
			"display",
		]);
		expect(database.queries.findIndex((sql) => sql.startsWith("DELETE"))).toBe(
			4,
		);
		expect(database.queries.at(-1)).toBe("COMMIT");
		expect(database.release).toHaveBeenCalledOnce();
	});

	it("rolls back PostgreSQL when R2 deletion fails", async () => {
		const database = fakePool({
			id: "photo-id",
			originalObjectKey: "original",
		});
		const storageError = new Error("storage unavailable");

		await expect(
			permanentlyDeletePhoto(
				database.pool,
				config,
				"vault-id",
				"photo-id",
				async () => {
					throw storageError;
				},
			),
		).rejects.toBe(storageError);
		expect(database.queries).not.toContain("DELETE FROM photos WHERE id = $1");
		expect(database.queries.at(-1)).toBe("ROLLBACK");
	});

	it("does not touch R2 for a photo outside the member's vault", async () => {
		const database = fakePool(undefined);
		const removeObjects = vi.fn(async () => undefined);

		await expect(
			permanentlyDeletePhoto(
				database.pool,
				config,
				"other-vault",
				"photo-id",
				removeObjects,
			),
		).resolves.toBe(false);
		expect(removeObjects).not.toHaveBeenCalled();
		expect(database.queries.at(-1)).toBe("ROLLBACK");
	});
});
