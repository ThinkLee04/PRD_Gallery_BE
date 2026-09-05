import { Type } from "@sinclair/typebox";
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
import {
	requireApprovedMember,
	requireCollection,
} from "../memberships/service.js";
import { triggerProcessing } from "../uploads/processor.js";
import { signDownload } from "../uploads/storage.js";
import {
	findAccessiblePhoto,
	type GalleryRow,
	galleryJoins,
	gallerySelect,
	toGalleryItem,
} from "./gallery.js";

function database(config: AppConfig) {
	const pool = getPool(config);
	if (pool === null)
		throw new ApiError(ErrorCodes.INTERNAL_ERROR, "Database unavailable.");
	return pool;
}

interface CollectionCursor {
	v: 1;
	collectionId: string;
	orderVersion: string;
	position: string;
	photoId: string;
}

export async function registerPhotosModule(
	app: FastifyInstance,
	config: AppConfig,
): Promise<void> {
	app.get("/v1/photos/:photoId", async (request, reply) => {
		const member = await requireApprovedMember(request, config);
		const { photoId } = request.params as { photoId: string };
		const result = await database(config).query<{
			id: string;
			mediaType: string;
			status: string;
			fileName: string;
			width: number | null;
			height: number | null;
			capturedAt: string | null;
			capturedTimezoneOffsetMinutes: number | null;
			uploadedAt: string;
			uploaderName: string;
			uploaderAvatarUrl: string | null;
			displayKey: string | null;
			displayWidth: number | null;
			displayHeight: number | null;
			loved: boolean;
		}>(
			`SELECT p.id, p.media_type AS "mediaType", p.status, p.original_filename AS "fileName",
			 p.width, p.height, p.captured_at AS "capturedAt", p.captured_timezone_offset_minutes AS "capturedTimezoneOffsetMinutes",
			 p.created_at AS "uploadedAt", u.display_name AS "uploaderName", u.avatar_url AS "uploaderAvatarUrl",
			 a.object_key AS "displayKey", a.width AS "displayWidth", a.height AS "displayHeight",
			 EXISTS (SELECT 1 FROM favorites f WHERE f.user_id = $3 AND f.photo_id = p.id) AS loved
			 FROM photos p JOIN users u ON u.id = p.uploaded_by_user_id
			 LEFT JOIN photo_assets a ON a.photo_id = p.id AND a.kind = 'DISPLAY'
			 WHERE p.id = $1 AND p.vault_id = $2`,
			[photoId, member.vaultId, member.userId],
		);
		const photo = result.rows[0];
		if (photo === undefined)
			throw new ApiError(ErrorCodes.NOT_FOUND, "Photo not found.");
		const display =
			photo.displayKey && photo.displayWidth && photo.displayHeight && config.r2
				? {
						...(await signDownload(config, photo.displayKey)),
						width: photo.displayWidth,
						height: photo.displayHeight,
					}
				: null;
		const {
			displayKey: _displayKey,
			displayWidth: _displayWidth,
			displayHeight: _displayHeight,
			uploaderName,
			uploaderAvatarUrl,
			...publicPhoto
		} = photo;
		reply.header("cache-control", "private, no-store");
		return {
			data: {
				...publicPhoto,
				aspectRatio:
					photo.width && photo.height ? photo.width / photo.height : null,
				uploader: {
					displayName: uploaderName,
					avatarUrl: uploaderAvatarUrl,
				},
				display,
			},
		};
	});

	app.get("/v1/collections/:collectionId/photos", async (request, reply) => {
		const member = await requireApprovedMember(request, config);
		const { collectionId } = request.params as { collectionId: string };
		const collection = await requireCollection(
			database(config),
			member,
			collectionId,
		);
		const query = request.query as { cursor?: string; limit?: string };
		const cursor = decodeCursor<CollectionCursor>(query.cursor);
		if (cursor !== null) {
			if (
				cursor.v !== 1 ||
				cursor.collectionId !== collectionId ||
				!isUuid(cursor.photoId) ||
				typeof cursor.position !== "string" ||
				!/^\d+$/.test(cursor.position) ||
				typeof cursor.orderVersion !== "string"
			)
				throw new ApiError(
					ErrorCodes.VALIDATION_ERROR,
					"Invalid pagination cursor.",
				);
			if (cursor.orderVersion !== collection.orderVersion)
				throw new ApiError(
					ErrorCodes.CONFLICT,
					"Collection order changed. Refresh the gallery.",
				);
		}
		const limit = pageLimit(query.limit);
		const select = gallerySelect("$5");
		const result = await database(config).query<
			GalleryRow & { position: string }
		>(
			`SELECT ${select}, cp.position::text AS position
			 FROM collection_photos cp JOIN photos p ON p.id = cp.photo_id ${galleryJoins()}
			 WHERE cp.collection_id = $1
			 AND ($2::bigint IS NULL OR (cp.position, p.id) > ($2::bigint, $3::uuid))
			 ORDER BY cp.position, p.id LIMIT $4`,
			[
				collectionId,
				cursor?.position ?? null,
				cursor?.photoId ?? null,
				limit + 1,
				member.userId,
			],
		);
		const hasMore = result.rows.length > limit;
		const rows = result.rows.slice(0, limit);
		const data = await Promise.all(
			rows.map((row) => toGalleryItem(config, row)),
		);
		const last = rows.at(-1);
		reply.header("cache-control", "private, no-store");
		return {
			data,
			page: {
				nextCursor:
					hasMore && last
						? encodeCursor({
								v: 1,
								collectionId,
								orderVersion: collection.orderVersion,
								position: last.position,
								photoId: last.id,
							})
						: null,
			},
		};
	});

	app.post(
		"/v1/photos/:photoId/original-url",
		{
			schema: {
				body: Type.Object({
					purpose: Type.Union([Type.Literal("view"), Type.Literal("download")]),
				}),
			},
		},
		async (request, reply) => {
			const member = await requireApprovedMember(request, config);
			const { photoId } = request.params as { photoId: string };
			const photo = await findAccessiblePhoto(
				database(config),
				member.vaultId,
				photoId,
			);
			if (photo === null || photo.status !== "READY")
				throw new ApiError(ErrorCodes.NOT_FOUND, "Photo not found.");
			const { purpose } = request.body as { purpose: "view" | "download" };
			reply.header("cache-control", "private, no-store");
			return {
				data: await signDownload(config, photo.objectKey, {
					fileName: photo.fileName,
					download: purpose === "download",
				}),
			};
		},
	);

	app.post(
		"/v1/photo-assets/urls",
		{
			schema: {
				body: Type.Object({
					photoIds: Type.Array(Type.String({ format: "uuid" }), {
						maxItems: 80,
					}),
				}),
			},
		},
		async (request, reply) => {
			const member = await requireApprovedMember(request, config);
			const { photoIds } = request.body as { photoIds: string[] };
			const select = gallerySelect("$3");
			const result = await database(config).query<GalleryRow>(
				`SELECT ${select} FROM photos p ${galleryJoins()}
			 WHERE p.vault_id = $1 AND p.id = ANY($2::uuid[])`,
				[member.vaultId, photoIds, member.userId],
			);
			if (result.rows.length !== new Set(photoIds).size)
				throw new ApiError(ErrorCodes.NOT_FOUND, "Photo not found.");
			reply.header("cache-control", "private, no-store");
			return {
				data: await Promise.all(
					result.rows.map((row) => toGalleryItem(config, row)),
				),
			};
		},
	);

	app.post("/v1/photos/:photoId/retry", async (request) => {
		const member = await requireApprovedMember(request, config);
		const { photoId } = request.params as { photoId: string };
		const photo = await findAccessiblePhoto(
			database(config),
			member.vaultId,
			photoId,
		);
		if (
			photo === null ||
			(member.role !== "OWNER" && photo.uploadedByUserId !== member.userId)
		)
			throw new ApiError(ErrorCodes.NOT_FOUND, "Photo not found.");
		if (photo.status !== "FAILED")
			throw new ApiError(ErrorCodes.CONFLICT, "Photo is not retryable.");
		await database(config).query(
			"UPDATE photos SET status = 'UPLOADED', processing_error_code = NULL, updated_at = now() WHERE id = $1",
			[photoId],
		);
		triggerProcessing(database(config), config);
		return { data: { id: photoId, status: "UPLOADED" } };
	});
}
