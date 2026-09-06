import type pg from "pg";
import type { AppConfig } from "../../config.js";
import { deleteObjects } from "../uploads/storage.js";

interface DeletablePhoto {
	id: string;
	originalObjectKey: string;
}

type ObjectDeleter = (
	config: AppConfig,
	keys: readonly string[],
) => Promise<void>;

export async function permanentlyDeletePhoto(
	pool: pg.Pool,
	config: AppConfig,
	vaultId: string,
	photoId: string,
	removeObjects: ObjectDeleter = deleteObjects,
): Promise<boolean> {
	const client = await pool.connect();
	try {
		await client.query("BEGIN");
		await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [photoId]);
		const result = await client.query<DeletablePhoto>(
			`SELECT p.id, p.original_object_key AS "originalObjectKey"
			 FROM photos p WHERE p.id = $1 AND p.vault_id = $2 FOR UPDATE`,
			[photoId, vaultId],
		);
		const photo = result.rows[0];
		if (photo === undefined) {
			await client.query("ROLLBACK");
			return false;
		}
		const assets = await client.query<{ objectKey: string }>(
			'SELECT object_key AS "objectKey" FROM photo_assets WHERE photo_id = $1',
			[photo.id],
		);

		await removeObjects(config, [
			photo.originalObjectKey,
			...assets.rows.map((asset) => asset.objectKey),
		]);
		await client.query("DELETE FROM photos WHERE id = $1", [photo.id]);
		await client.query("COMMIT");
		return true;
	} catch (error) {
		await client.query("ROLLBACK").catch(() => undefined);
		throw error;
	} finally {
		client.release();
	}
}
