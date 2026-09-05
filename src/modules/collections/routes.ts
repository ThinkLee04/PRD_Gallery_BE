import { Type } from "@sinclair/typebox";
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
import {
	canManageCollection,
	requireApprovedMember,
	requireCollection,
} from "../memberships/service.js";
import { signDownload } from "../uploads/storage.js";

interface ListCursor {
	v: 1;
	at: string;
	id: string;
}
const CollectionBody = Type.Object({
	name: Type.String({ minLength: 1, maxLength: 120 }),
	description: Type.Optional(
		Type.Union([Type.String({ maxLength: 2000 }), Type.Null()]),
	),
	eventDate: Type.Optional(
		Type.Union([
			Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }),
			Type.Null(),
		]),
	),
});

function eventDateValue(value: string | null | undefined): string | null {
	if (value === undefined || value === null || value === "") return null;
	const date = new Date(`${value}T00:00:00.000Z`);
	if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== value)
		throw new ApiError(ErrorCodes.VALIDATION_ERROR, "Invalid event date.");
	return value;
}

function database(config: AppConfig) {
	const pool = getPool(config);
	if (pool === null)
		throw new ApiError(ErrorCodes.INTERNAL_ERROR, "Database unavailable.");
	return pool;
}

export async function registerCollectionsModule(
	app: FastifyInstance,
	config: AppConfig,
): Promise<void> {
	app.get("/v1/collections", async (request) => {
		const member = await requireApprovedMember(request, config);
		const query = request.query as {
			state?: "active" | "archived";
			cursor?: string;
			limit?: string;
		};
		const state = query.state ?? "active";
		if (state !== "active" && state !== "archived")
			throw new ApiError(
				ErrorCodes.VALIDATION_ERROR,
				"Invalid collection state.",
			);
		const cursor = decodeCursor<ListCursor>(query.cursor);
		if (
			cursor !== null &&
			(cursor.v !== 1 || !isIsoDate(cursor.at) || !isUuid(cursor.id))
		)
			throw new ApiError(
				ErrorCodes.VALIDATION_ERROR,
				"Invalid pagination cursor.",
			);
		const limit = pageLimit(query.limit);
		const timestampColumn =
			state === "active" ? "c.created_at" : "c.archived_at";
		const visibility =
			state === "active"
				? "c.archived_at IS NULL"
				: "c.archived_at IS NOT NULL";
		const result = await database(config).query<{
			id: string;
			name: string;
			description: string | null;
			createdByUserId: string;
			createdAt: string;
			updatedAt: string;
			archivedAt: string | null;
			eventDate: string | null;
			cursorAt: string;
			photoCount: string;
			creatorName: string;
			creatorAvatarUrl: string | null;
			coverKey: string | null;
			coverWidth: number | null;
			coverHeight: number | null;
		}>(
			`SELECT c.id, c.name, c.description, to_char(c.event_date, 'YYYY-MM-DD') AS "eventDate", c.created_by_user_id AS "createdByUserId",
			 c.created_at AS "createdAt", c.updated_at AS "updatedAt", c.archived_at AS "archivedAt",
			 ${timestampColumn} AS "cursorAt",
			 (SELECT count(*)::text FROM collection_photos cp0 WHERE cp0.collection_id = c.id) AS "photoCount",
			 creator.display_name AS "creatorName", creator.avatar_url AS "creatorAvatarUrl",
			 cover.object_key AS "coverKey", cover.width AS "coverWidth", cover.height AS "coverHeight"
			 FROM collections c
			 JOIN users creator ON creator.id = c.created_by_user_id
			 LEFT JOIN LATERAL (
				 SELECT asset.object_key, asset.width, asset.height
				 FROM collection_photos cp
				 JOIN photos p ON p.id = cp.photo_id AND p.status = 'READY'
				 JOIN photo_assets asset ON asset.photo_id = p.id AND asset.kind = 'THUMBNAIL_SM'
				 WHERE cp.collection_id = c.id
				 ORDER BY cp.position, cp.photo_id LIMIT 1
			 ) cover ON true
			 WHERE c.vault_id = $1 AND ${visibility}
			 AND ($2::timestamptz IS NULL OR (${timestampColumn}, c.id) < ($2::timestamptz, $3::uuid))
			 ORDER BY ${timestampColumn} DESC, c.id DESC LIMIT $4`,
			[member.vaultId, cursor?.at ?? null, cursor?.id ?? null, limit + 1],
		);
		const hasMore = result.rows.length > limit;
		const rows = await Promise.all(
			result.rows.slice(0, limit).map(async (row) => {
				const cover =
					row.coverKey !== null &&
					row.coverWidth !== null &&
					row.coverHeight !== null &&
					config.r2 !== null
						? {
								...(await signDownload(config, row.coverKey)),
								width: row.coverWidth,
								height: row.coverHeight,
							}
						: null;
				const {
					coverKey: _coverKey,
					coverWidth: _coverWidth,
					coverHeight: _coverHeight,
					...collection
				} = row;
				return {
					...collection,
					photoCount: Number(row.photoCount),
					canManage: canManageCollection(member, row.createdByUserId),
					cover,
				};
			}),
		);
		const last = rows.at(-1);
		return {
			data: rows,
			page: {
				nextCursor:
					hasMore && last
						? encodeCursor({ v: 1, at: last.cursorAt, id: last.id })
						: null,
			},
		};
	});

	app.post(
		"/v1/collections",
		{ schema: { body: CollectionBody } },
		async (request, reply) => {
			const member = await requireApprovedMember(request, config);
			const body = request.body as {
				name: string;
				description?: string | null;
				eventDate?: string | null;
			};
			const name = body.name.trim();
			if (name === "")
				throw new ApiError(
					ErrorCodes.VALIDATION_ERROR,
					"Collection name is required.",
				);
			const result = await database(config).query(
				`INSERT INTO collections (vault_id, name, description, event_date, created_by_user_id)
			 VALUES ($1, $2, $3, $4, $5)
			 RETURNING id, name, description, to_char(event_date, 'YYYY-MM-DD') AS "eventDate", created_at AS "createdAt"`,
				[
					member.vaultId,
					name,
					body.description?.trim() || null,
					eventDateValue(body.eventDate),
					member.userId,
				],
			);
			return reply
				.code(201)
				.send({ data: { ...result.rows[0], canManage: true, photoCount: 0 } });
		},
	);

	app.get("/v1/collections/:collectionId", async (request) => {
		const member = await requireApprovedMember(request, config);
		const { collectionId } = request.params as { collectionId: string };
		const access = await requireCollection(
			database(config),
			member,
			collectionId,
			{
				includeArchived: true,
			},
		);
		if (
			access.archivedAt !== null &&
			!canManageCollection(member, access.createdByUserId)
		)
			throw new ApiError(ErrorCodes.NOT_FOUND, "Collection not found.");
		const result = await database(config).query(
			`SELECT c.id, c.name, c.description, to_char(c.event_date, 'YYYY-MM-DD') AS "eventDate", c.created_by_user_id AS "createdByUserId",
			 c.created_at AS "createdAt", c.updated_at AS "updatedAt", c.archived_at AS "archivedAt",
			 c.order_version::text AS "orderVersion", count(cp.photo_id)::int AS "photoCount"
			 FROM collections c LEFT JOIN collection_photos cp ON cp.collection_id = c.id
			 WHERE c.id = $1 GROUP BY c.id`,
			[collectionId],
		);
		const row = result.rows[0] as { createdByUserId: string };
		return {
			data: {
				...row,
				canManage: canManageCollection(member, row.createdByUserId),
			},
		};
	});

	app.patch(
		"/v1/collections/:collectionId",
		{ schema: { body: Type.Partial(CollectionBody) } },
		async (request) => {
			const member = await requireApprovedMember(request, config);
			const { collectionId } = request.params as { collectionId: string };
			await requireCollection(database(config), member, collectionId, {
				includeArchived: true,
				manage: true,
			});
			const body = request.body as {
				name?: string;
				description?: string | null;
				eventDate?: string | null;
			};
			if (
				body.name === undefined &&
				body.description === undefined &&
				body.eventDate === undefined
			)
				throw new ApiError(ErrorCodes.VALIDATION_ERROR, "No changes supplied.");
			if (body.name !== undefined && body.name.trim() === "")
				throw new ApiError(
					ErrorCodes.VALIDATION_ERROR,
					"Collection name is required.",
				);
			const result = await database(config).query(
				`UPDATE collections SET name = COALESCE($2, name),
			 description = CASE WHEN $3 THEN $4 ELSE description END,
			 event_date = CASE WHEN $5 THEN $6 ELSE event_date END,
			 updated_at = now() WHERE id = $1
			 RETURNING id, name, description, to_char(event_date, 'YYYY-MM-DD') AS "eventDate", updated_at AS "updatedAt"`,
				[
					collectionId,
					body.name?.trim() || null,
					body.description !== undefined,
					body.description?.trim() || null,
					body.eventDate !== undefined,
					eventDateValue(body.eventDate),
				],
			);
			return { data: result.rows[0] };
		},
	);

	for (const action of ["archive", "restore"] as const) {
		app.post(`/v1/collections/:collectionId/${action}`, async (request) => {
			const member = await requireApprovedMember(request, config);
			const { collectionId } = request.params as { collectionId: string };
			await requireCollection(database(config), member, collectionId, {
				includeArchived: true,
				manage: true,
			});
			const archived = action === "archive";
			const result = await database(config).query(
				`UPDATE collections SET archived_at = ${archived ? "COALESCE(archived_at, now())" : "NULL"}, updated_at = now()
				 WHERE id = $1 RETURNING id, archived_at AS "archivedAt"`,
				[collectionId],
			);
			return { data: result.rows[0] };
		});
	}

	app.put("/v1/collections/:collectionId/photos/:photoId", async (request) => {
		const member = await requireApprovedMember(request, config);
		const { collectionId, photoId } = request.params as {
			collectionId: string;
			photoId: string;
		};
		await requireCollection(database(config), member, collectionId, {
			manage: true,
		});
		const result = await database(config).query(
			`INSERT INTO collection_photos (collection_id, photo_id, position, added_by_user_id)
			 SELECT $1, p.id, COALESCE((SELECT max(position) + 1 FROM collection_photos WHERE collection_id = $1), 1), $3
			 FROM photos p WHERE p.id = $2 AND p.vault_id = $4
			 ON CONFLICT (collection_id, photo_id) DO NOTHING RETURNING photo_id AS "photoId"`,
			[collectionId, photoId, member.userId, member.vaultId],
		);
		if (result.rowCount === 0) {
			const exists = await database(config).query(
				"SELECT 1 FROM photos WHERE id = $1 AND vault_id = $2",
				[photoId, member.vaultId],
			);
			if (exists.rowCount === 0)
				throw new ApiError(ErrorCodes.NOT_FOUND, "Photo not found.");
		}
		return { data: { photoId } };
	});

	app.delete(
		"/v1/collections/:collectionId/photos/:photoId",
		async (request, reply) => {
			const member = await requireApprovedMember(request, config);
			const { collectionId, photoId } = request.params as {
				collectionId: string;
				photoId: string;
			};
			await requireCollection(database(config), member, collectionId, {
				manage: true,
			});
			await database(config).query(
				"DELETE FROM collection_photos WHERE collection_id = $1 AND photo_id = $2",
				[collectionId, photoId],
			);
			return reply.code(204).send();
		},
	);

	app.patch(
		"/v1/collections/:collectionId/photos/:photoId/position",
		{
			schema: {
				body: Type.Object({
					beforePhotoId: Type.Union([
						Type.String({ format: "uuid" }),
						Type.Null(),
					]),
				}),
			},
		},
		async (request) => {
			const member = await requireApprovedMember(request, config);
			const { collectionId, photoId } = request.params as {
				collectionId: string;
				photoId: string;
			};
			const { beforePhotoId } = request.body as {
				beforePhotoId: string | null;
			};
			const collection = await requireCollection(
				database(config),
				member,
				collectionId,
				{
					manage: true,
				},
			);
			if (beforePhotoId === photoId)
				return { data: { photoId, orderVersion: collection.orderVersion } };
			const client = await database(config).connect();
			try {
				await client.query("BEGIN");
				await client.query(
					"SET CONSTRAINTS collection_photos_position_unique DEFERRED",
				);
				const locked = await client.query<{ photoId: string }>(
					`SELECT photo_id AS "photoId" FROM collection_photos WHERE collection_id = $1 ORDER BY position, photo_id FOR UPDATE`,
					[collectionId],
				);
				const ordered = locked.rows.map((row) => row.photoId);
				const from = ordered.indexOf(photoId);
				if (
					from < 0 ||
					(beforePhotoId !== null && !ordered.includes(beforePhotoId))
				)
					throw new ApiError(
						ErrorCodes.NOT_FOUND,
						"Photo not found in Collection.",
					);
				ordered.splice(from, 1);
				const target =
					beforePhotoId === null
						? ordered.length
						: ordered.indexOf(beforePhotoId);
				ordered.splice(target, 0, photoId);
				for (let index = 0; index < ordered.length; index += 1) {
					await client.query(
						"UPDATE collection_photos SET position = $3 WHERE collection_id = $1 AND photo_id = $2",
						[collectionId, ordered[index], index + 1],
					);
				}
				const version = await client.query<{ orderVersion: string }>(
					`UPDATE collections SET order_version = order_version + 1, updated_at = now() WHERE id = $1 RETURNING order_version::text AS "orderVersion"`,
					[collectionId],
				);
				await client.query("COMMIT");
				return {
					data: { photoId, orderVersion: version.rows[0]?.orderVersion },
				};
			} catch (error) {
				await client.query("ROLLBACK").catch(() => undefined);
				throw error;
			} finally {
				client.release();
			}
		},
	);
}
