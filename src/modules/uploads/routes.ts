import { randomUUID } from "node:crypto";
import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../../config.js";
import { getPool } from "../../db/pool.js";
import { ApiError, ErrorCodes } from "../../lib/errors.js";
import { createRateLimitHook } from "../auth/rate-limit.js";
import {
	requireApprovedMember,
	requireCollection,
} from "../memberships/service.js";
import { findAccessiblePhoto } from "../photos/gallery.js";
import { assertMediaRuntime, triggerProcessing } from "./processor.js";
import { headObject, signUpload } from "./storage.js";

const TYPES = new Map<string, "IMAGE" | "VIDEO">([
	["image/jpeg", "IMAGE"],
	["image/png", "IMAGE"],
	["image/webp", "IMAGE"],
	["image/heic", "IMAGE"],
	["image/heif", "IMAGE"],
	["video/mp4", "VIDEO"],
	["video/quicktime", "VIDEO"],
]);

function database(config: AppConfig) {
	const pool = getPool(config);
	if (pool === null)
		throw new ApiError(ErrorCodes.INTERNAL_ERROR, "Database unavailable.");
	return pool;
}

function safeFileName(value: string): string {
	const name = value
		.replace(/^.*[\\/]/, "")
		.split("")
		.map((character) => {
			const code = character.charCodeAt(0);
			return code < 32 || code === 127 ? "_" : character;
		})
		.join("")
		.trim()
		.slice(0, 255);
	if (name === "")
		throw new ApiError(ErrorCodes.VALIDATION_ERROR, "Invalid file name.");
	return name;
}

export async function registerUploadsModule(
	app: FastifyInstance,
	config: AppConfig,
): Promise<void> {
	assertMediaRuntime(config);
	const uploadRateLimit = createRateLimitHook({ max: 60, windowMs: 60_000 });
	app.post(
		"/v1/collections/:collectionId/uploads",
		{
			preHandler: uploadRateLimit,
			schema: {
				body: Type.Object({
					fileName: Type.String({ minLength: 1, maxLength: 500 }),
					byteSize: Type.Integer({ minimum: 1 }),
					contentType: Type.String({ minLength: 1, maxLength: 100 }),
				}),
			},
		},
		async (request, reply) => {
			const member = await requireApprovedMember(request, config);
			const { collectionId } = request.params as { collectionId: string };
			await requireCollection(database(config), member, collectionId, {
				manage: true,
			});
			const body = request.body as {
				fileName: string;
				byteSize: number;
				contentType: string;
			};
			const contentType = body.contentType.toLowerCase().split(";")[0] ?? "";
			const mediaType = TYPES.get(contentType);
			if (mediaType === undefined)
				throw new ApiError(
					ErrorCodes.VALIDATION_ERROR,
					"Unsupported media type.",
				);
			const maximum =
				mediaType === "IMAGE"
					? config.maxImageUploadBytes
					: config.maxVideoUploadBytes;
			if (body.byteSize > maximum)
				throw new ApiError(
					ErrorCodes.VALIDATION_ERROR,
					`File exceeds the ${Math.round(maximum / 1048576)} MB limit.`,
				);
			const photoId = randomUUID();
			const objectKey = `vaults/${member.vaultId}/photos/${photoId}/original`;
			const upload = await signUpload(config, objectKey, contentType);
			const client = await database(config).connect();
			try {
				await client.query("BEGIN");
				await client.query(
					"SELECT id FROM collections WHERE id = $1 FOR UPDATE",
					[collectionId],
				);
				await client.query(
					`INSERT INTO photos (id, vault_id, uploaded_by_user_id, media_type, status, original_object_key,
				 original_filename, content_type, byte_size) VALUES ($1, $2, $3, $4, 'PENDING_UPLOAD', $5, $6, $7, $8)`,
					[
						photoId,
						member.vaultId,
						member.userId,
						mediaType,
						objectKey,
						safeFileName(body.fileName),
						contentType,
						body.byteSize,
					],
				);
				await client.query(
					`INSERT INTO collection_photos (collection_id, photo_id, position, added_by_user_id)
				 VALUES ($1, $2, COALESCE((SELECT max(position) + 1 FROM collection_photos WHERE collection_id = $1), 1), $3)`,
					[collectionId, photoId, member.userId],
				);
				await client.query("COMMIT");
			} catch (error) {
				await client.query("ROLLBACK").catch(() => undefined);
				throw error;
			} finally {
				client.release();
			}
			return reply.code(201).send({
				data: {
					photoId,
					status: "PENDING_UPLOAD",
					upload: { ...upload, method: "PUT" },
				},
			});
		},
	);

	app.post("/v1/photos/:photoId/upload-complete", async (request) => {
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
		if (["UPLOADED", "PROCESSING", "READY"].includes(photo.status))
			return { data: { id: photoId, status: photo.status } };
		if (photo.status !== "PENDING_UPLOAD")
			throw new ApiError(
				ErrorCodes.CONFLICT,
				"Upload cannot be completed in its current state.",
			);
		const expected = await database(config).query<{ byteSize: string }>(
			'SELECT byte_size::text AS "byteSize" FROM photos WHERE id = $1',
			[photoId],
		);
		const object = await headObject(config, photo.objectKey).catch(() => {
			throw new ApiError(
				ErrorCodes.CONFLICT,
				"Uploaded object is not available yet.",
			);
		});
		if (object.byteSize !== Number(expected.rows[0]?.byteSize))
			throw new ApiError(
				ErrorCodes.CONFLICT,
				"Uploaded object size does not match.",
			);
		await database(config).query(
			"UPDATE photos SET status = 'UPLOADED', updated_at = now() WHERE id = $1 AND status = 'PENDING_UPLOAD'",
			[photoId],
		);
		triggerProcessing(database(config), config);
		return { data: { id: photoId, status: "UPLOADED" } };
	});

	const pool = getPool(config);
	if (pool !== null) triggerProcessing(pool, config);
}
