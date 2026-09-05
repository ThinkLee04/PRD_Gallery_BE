import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../../config.js";
import { getPool } from "../../db/pool.js";
import {
	decodeCursor,
	encodeCursor,
	isIsoDate,
	isUuid,
	pageLimit,
} from "../../lib/cursor.js";
import { ApiError, ErrorCodes } from "../../lib/errors.js";
import { requireApprovedMember } from "../memberships/service.js";
import {
	findAccessiblePhoto,
	type GalleryRow,
	galleryJoins,
	gallerySelect,
	toGalleryItem,
} from "../photos/gallery.js";

interface LovedCursor {
	v: 1;
	favoritedAt: string;
	photoId: string;
}
function database(config: AppConfig) {
	const pool = getPool(config);
	if (pool === null)
		throw new ApiError(ErrorCodes.INTERNAL_ERROR, "Database unavailable.");
	return pool;
}

export async function registerFavoritesModule(
	app: FastifyInstance,
	config: AppConfig,
): Promise<void> {
	app.get("/v1/loved", async (request, reply) => {
		const member = await requireApprovedMember(request, config);
		const query = request.query as { cursor?: string; limit?: string };
		const cursor = decodeCursor<LovedCursor>(query.cursor);
		if (
			cursor !== null &&
			(cursor.v !== 1 ||
				!isIsoDate(cursor.favoritedAt) ||
				!isUuid(cursor.photoId))
		)
			throw new ApiError(
				ErrorCodes.VALIDATION_ERROR,
				"Invalid pagination cursor.",
			);
		const limit = pageLimit(query.limit);
		const select = gallerySelect("$5");
		const result = await database(config).query<
			GalleryRow & { favoritedAt: string }
		>(
			`SELECT ${select}, f.created_at AS "favoritedAt"
			 FROM favorites f JOIN photos p ON p.id = f.photo_id ${galleryJoins()}
			 WHERE f.user_id = $1 AND p.vault_id = $2
			 AND ($3::timestamptz IS NULL OR (f.created_at, p.id) < ($3::timestamptz, $4::uuid))
			 ORDER BY f.created_at DESC, p.id DESC LIMIT $6`,
			[
				member.userId,
				member.vaultId,
				cursor?.favoritedAt ?? null,
				cursor?.photoId ?? null,
				member.userId,
				limit + 1,
			],
		);
		const hasMore = result.rows.length > limit;
		const rows = result.rows.slice(0, limit);
		reply.header("cache-control", "private, no-store");
		return {
			data: await Promise.all(rows.map((row) => toGalleryItem(config, row))),
			page: {
				nextCursor:
					hasMore && rows.at(-1)
						? encodeCursor({
								v: 1,
								favoritedAt: rows.at(-1)?.favoritedAt,
								photoId: rows.at(-1)?.id,
							})
						: null,
			},
		};
	});

	app.put("/v1/photos/:photoId/favorite", async (request) => {
		const member = await requireApprovedMember(request, config);
		const { photoId } = request.params as { photoId: string };
		if (
			(await findAccessiblePhoto(database(config), member.vaultId, photoId)) ===
			null
		)
			throw new ApiError(ErrorCodes.NOT_FOUND, "Photo not found.");
		await database(config).query(
			"INSERT INTO favorites (user_id, photo_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
			[member.userId, photoId],
		);
		return { data: { photoId, loved: true } };
	});

	app.delete("/v1/photos/:photoId/favorite", async (request, reply) => {
		const member = await requireApprovedMember(request, config);
		const { photoId } = request.params as { photoId: string };
		if (
			(await findAccessiblePhoto(database(config), member.vaultId, photoId)) ===
			null
		)
			throw new ApiError(ErrorCodes.NOT_FOUND, "Photo not found.");
		await database(config).query(
			"DELETE FROM favorites WHERE user_id = $1 AND photo_id = $2",
			[member.userId, photoId],
		);
		return reply.code(204).send();
	});
}
