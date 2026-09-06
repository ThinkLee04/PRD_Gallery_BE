import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../../config.js";
import { getPool } from "../../db/pool.js";
import {
	decodeCursor,
	encodeCursor,
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
	v: 2;
	sort:
		| "captured_asc"
		| "captured_desc"
		| "uploaded_asc"
		| "uploaded_desc"
		| "alphabet_asc"
		| "alphabet_desc";
	media: "all" | "image" | "video";
	uploaderId: string | null;
	sortValue: string;
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
	app.get("/v1/loved/uploaders", async (request, reply) => {
		const member = await requireApprovedMember(request, config);
		const result = await database(config).query<{
			id: string;
			displayName: string;
			avatarUrl: string | null;
			photoCount: number;
		}>(
			`SELECT u.id, u.display_name AS "displayName", u.avatar_url AS "avatarUrl",
			 count(*)::int AS "photoCount"
			 FROM favorites f
			 JOIN photos p ON p.id = f.photo_id
			 JOIN users u ON u.id = p.uploaded_by_user_id
			 WHERE f.user_id = $1 AND p.vault_id = $2
			 GROUP BY u.id
			 ORDER BY LOWER(u.display_name) COLLATE "C", u.id`,
			[member.userId, member.vaultId],
		);
		reply.header("cache-control", "private, no-store");
		return { data: result.rows };
	});

	app.get("/v1/loved", async (request, reply) => {
		const member = await requireApprovedMember(request, config);
		const query = request.query as {
			cursor?: string;
			limit?: string;
			sort?: string;
			media?: string;
			uploaderId?: string;
		};
		const sort = query.sort ?? "captured_desc";
		const media = query.media ?? "all";
		const uploaderId = query.uploaderId ?? null;
		if (
			![
				"captured_asc",
				"captured_desc",
				"uploaded_asc",
				"uploaded_desc",
				"alphabet_asc",
				"alphabet_desc",
			].includes(sort)
		)
			throw new ApiError(ErrorCodes.VALIDATION_ERROR, "Invalid gallery sort.");
		if (!["all", "image", "video"].includes(media))
			throw new ApiError(ErrorCodes.VALIDATION_ERROR, "Invalid media filter.");
		if (uploaderId !== null && !isUuid(uploaderId))
			throw new ApiError(
				ErrorCodes.VALIDATION_ERROR,
				"Invalid uploader filter.",
			);
		const cursor = decodeCursor<LovedCursor>(query.cursor);
		if (cursor !== null) {
			if (
				cursor.v !== 2 ||
				cursor.sort !== sort ||
				cursor.media !== media ||
				cursor.uploaderId !== uploaderId ||
				!isUuid(cursor.photoId) ||
				typeof cursor.sortValue !== "string" ||
				(sort.startsWith("alphabet_")
					? cursor.sortValue.length === 0
					: Number.isNaN(Date.parse(cursor.sortValue)))
			)
				throw new ApiError(
					ErrorCodes.VALIDATION_ERROR,
					"Invalid pagination cursor.",
				);
		}
		const limit = pageLimit(query.limit);
		const select = gallerySelect("$5");
		const alphabetic = sort.startsWith("alphabet_");
		const sortExpression = alphabetic
			? 'LOWER(p.original_filename) COLLATE "C"'
			: sort.startsWith("uploaded_")
				? "p.created_at"
				: "COALESCE(p.captured_at, p.created_at)";
		const sortCast = alphabetic ? 'text COLLATE "C"' : "timestamptz";
		const direction = sort.endsWith("_asc") ? "ASC" : "DESC";
		const comparison = direction === "ASC" ? ">" : "<";
		const result = await database(config).query<
			GalleryRow & { sortValue: string }
		>(
			`SELECT ${select}, (${sortExpression})::text AS "sortValue"
			 FROM favorites f JOIN photos p ON p.id = f.photo_id ${galleryJoins()}
			 WHERE f.user_id = $1 AND p.vault_id = $2
			 AND ($6::text = 'all' OR p.media_type = UPPER($6::text))
			 AND ($7::uuid IS NULL OR p.uploaded_by_user_id = $7::uuid)
			 AND ($3::${sortCast} IS NULL OR (${sortExpression}, p.id) ${comparison} ($3::${sortCast}, $4::uuid))
			 ORDER BY ${sortExpression} ${direction}, p.id ${direction} LIMIT $8`,
			[
				member.userId,
				member.vaultId,
				cursor?.sortValue ?? null,
				cursor?.photoId ?? null,
				member.userId,
				media,
				uploaderId,
				limit + 1,
			],
		);
		const hasMore = result.rows.length > limit;
		const rows = result.rows.slice(0, limit);
		reply.header("cache-control", "private, no-store");
		const last = rows.at(-1);
		return {
			data: await Promise.all(rows.map((row) => toGalleryItem(config, row))),
			page: {
				nextCursor:
					hasMore && last
						? encodeCursor({
								v: 2,
								sort,
								media,
								uploaderId,
								sortValue: last.sortValue,
								photoId: last.id,
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
