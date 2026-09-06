import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import { closePool, createPoolFromUrl } from "../src/db/pool.js";
import { createSession, newSessionToken } from "../src/modules/auth/session.js";
import { bootstrapUserAccess } from "../src/modules/memberships/service.js";

const DATABASE_URL = process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

describeDb("gallery authorization and privacy", () => {
	const suffix = randomUUID();
	const config: AppConfig = {
		nodeEnv: "test",
		host: "127.0.0.1",
		port: 0,
		corsOrigin: "http://localhost:5173",
		databaseUrl: DATABASE_URL as string,
		appBaseUrl: "http://localhost:5173",
		googleClientId: "test",
		googleClientSecret: "test",
		googleRedirectUri: "http://localhost/callback",
		sessionSecret: "gallery-secret-0123456789abcdef0123456789abcdef",
		sessionTtlDays: 30,
		authRateLimitMax: 1000,
		authRateLimitWindowSeconds: 60,
		uploadRateLimitMax: 300,
		uploadRateLimitWindowSeconds: 60,
		adminEmails: [],
		vaultName: "Test",
		r2: null,
		r2UploadUrlTtlSeconds: 1800,
		r2DownloadUrlTtlSeconds: 600,
		maxImageUploadBytes: 104857600,
		maxVideoUploadBytes: 209715200,
	};
	let app: FastifyInstance;
	let setupPool: pg.Pool;
	let vaultId: string;
	let ownerId: string;
	let memberId: string;
	let outsiderId: string;
	let collectionId: string;
	let ownerCollectionId: string;
	let photoId: string;
	let ownerCookie: string;
	let memberCookie: string;
	let outsiderCookie: string;

	beforeAll(async () => {
		setupPool = createPoolFromUrl(DATABASE_URL as string);
		const user = async (label: string) =>
			(
				await setupPool.query<{ id: string }>(
					`INSERT INTO users (google_subject, email, display_name, approval_status)
			 VALUES ($1, $2, $3, 'APPROVED') RETURNING id`,
					[
						`gallery-${label}-${suffix}`,
						`${label}-${suffix}@example.com`,
						label,
					],
				)
			).rows[0]?.id as string;
		ownerId = await user("owner");
		memberId = await user("member");
		outsiderId = await user("outsider");
		const ownerEmail = `owner-${suffix}@example.com`;
		await bootstrapUserAccess(setupPool, {
			userId: ownerId,
			email: ownerEmail,
			adminEmails: [ownerEmail],
			vaultName: "Gallery Test",
		});
		vaultId = (
			await setupPool.query<{ id: string }>(
				"SELECT id FROM vaults WHERE singleton_key",
			)
		).rows[0]?.id as string;
		await setupPool.query(
			"INSERT INTO vault_memberships (vault_id, user_id, role) VALUES ($1,$2,'MEMBER')",
			[vaultId, memberId],
		);
		collectionId = (
			await setupPool.query<{ id: string }>(
				"INSERT INTO collections (vault_id,name,created_by_user_id) VALUES ($1,'Member album',$2) RETURNING id",
				[vaultId, memberId],
			)
		).rows[0]?.id as string;
		ownerCollectionId = (
			await setupPool.query<{ id: string }>(
				"INSERT INTO collections (vault_id,name,created_by_user_id) VALUES ($1,'Owner album',$2) RETURNING id",
				[vaultId, ownerId],
			)
		).rows[0]?.id as string;
		photoId = (
			await setupPool.query<{ id: string }>(
				`INSERT INTO photos (vault_id, uploaded_by_user_id, media_type, status, original_object_key, original_filename, content_type, byte_size, width, height)
			 VALUES ($1,$2,'IMAGE','READY',$3,'photo.jpg','image/jpeg',10,100,100) RETURNING id`,
				[vaultId, memberId, `vaults/${vaultId}/test-${suffix}`],
			)
		).rows[0]?.id as string;
		await setupPool.query(
			`INSERT INTO photo_assets (photo_id, kind, object_key, content_type, byte_size, width, height)
			 VALUES ($1, 'THUMBNAIL_SM', $2, 'image/webp', 10, 100, 100)`,
			[photoId, `vaults/${vaultId}/test-${suffix}-thumb-sm.webp`],
		);
		await setupPool.query(
			"INSERT INTO collection_photos (collection_id,photo_id,position,added_by_user_id) VALUES ($1,$2,1,$3)",
			[collectionId, photoId, memberId],
		);
		await setupPool.query(
			"INSERT INTO favorites (user_id,photo_id) VALUES ($1,$2)",
			[ownerId, photoId],
		);
		const session = async (userId: string) => {
			const value = newSessionToken();
			await createSession(setupPool, {
				userId,
				tokenHash: value.tokenHash,
				ttlDays: 1,
			});
			return `photo_vault_session=${value.token}`;
		};
		ownerCookie = await session(ownerId);
		memberCookie = await session(memberId);
		outsiderCookie = await session(outsiderId);
		app = await buildApp(config);
	});

	afterAll(async () => {
		await app?.close();
		await closePool();
		if (setupPool) {
			await setupPool.query(
				"DELETE FROM collections WHERE id = ANY($1::uuid[])",
				[[collectionId, ownerCollectionId]],
			);
			await setupPool.query("DELETE FROM photos WHERE id = $1", [photoId]);
			await setupPool.query("DELETE FROM vaults WHERE id = $1", [vaultId]);
			await setupPool.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [
				[ownerId, memberId, outsiderId],
			]);
			await setupPool.end();
		}
	});

	it("returns NOT_FOUND to an approved non-member", async () => {
		const response = await app.inject({
			method: "GET",
			url: `/v1/collections/${collectionId}`,
			headers: { cookie: outsiderCookie },
		});
		expect(response.statusCode).toBe(404);
		expect(response.json().error.code).toBe("NOT_FOUND");

		const gallery = await app.inject({
			method: "GET",
			url: `/v1/collections/${collectionId}/photos`,
			headers: { cookie: outsiderCookie },
		});
		expect(gallery.statusCode).toBe(404);
		expect(gallery.json().error.code).toBe("NOT_FOUND");

		const uploaders = await app.inject({
			method: "GET",
			url: `/v1/collections/${collectionId}/uploaders`,
			headers: { cookie: outsiderCookie },
		});
		expect(uploaders.statusCode).toBe(404);
		expect(uploaders.json().error.code).toBe("NOT_FOUND");

		for (const url of ["/v1/loved", "/v1/loved/uploaders"]) {
			const loved = await app.inject({
				method: "GET",
				url,
				headers: { cookie: outsiderCookie },
			});
			expect(loved.statusCode).toBe(404);
			expect(loved.json().error.code).toBe("NOT_FOUND");
		}

		const originalUrl = await app.inject({
			method: "POST",
			url: `/v1/photos/${photoId}/original-url`,
			headers: { cookie: outsiderCookie },
			payload: { purpose: "view" },
		});
		expect(originalUrl.statusCode).toBe(404);
		expect(originalUrl.json().error.code).toBe("NOT_FOUND");

		const deletePhoto = await app.inject({
			method: "DELETE",
			url: `/v1/photos/${photoId}`,
			headers: { cookie: outsiderCookie },
		});
		expect(deletePhoto.statusCode).toBe(404);
		expect(deletePhoto.json().error.code).toBe("NOT_FOUND");

		for (const mutation of [
			{
				method: "PATCH" as const,
				url: `/v1/collections/${ownerCollectionId}`,
				payload: { name: "Not allowed" },
			},
			{
				method: "DELETE" as const,
				url: `/v1/collections/${ownerCollectionId}/photos/${photoId}`,
			},
			{
				method: "POST" as const,
				url: `/v1/collections/${ownerCollectionId}/uploads`,
				payload: {
					fileName: "blocked.jpg",
					byteSize: 10,
					contentType: "image/jpeg",
				},
			},
			{
				method: "PUT" as const,
				url: `/v1/collections/${ownerCollectionId}/cover`,
				payload: { photoId },
			},
		]) {
			const denied = await app.inject({
				...mutation,
				headers: { cookie: outsiderCookie },
			});
			expect(denied.statusCode).toBe(404);
			expect(denied.json().error.code).toBe("NOT_FOUND");
		}
	});

	it("lets an approved member fully manage another member's shared album", async () => {
		const detail = await app.inject({
			method: "GET",
			url: `/v1/collections/${ownerCollectionId}`,
			headers: { cookie: memberCookie },
		});
		expect(detail.statusCode).toBe(200);
		expect(detail.json().data.canManage).toBe(true);

		const edited = await app.inject({
			method: "PATCH",
			url: `/v1/collections/${ownerCollectionId}`,
			headers: { cookie: memberCookie },
			payload: { name: "Shared album" },
		});
		expect(edited.statusCode).toBe(200);

		const added = await app.inject({
			method: "PUT",
			url: `/v1/collections/${ownerCollectionId}/photos/${photoId}`,
			headers: { cookie: memberCookie },
		});
		expect(added.statusCode).toBe(200);

		const removed = await app.inject({
			method: "DELETE",
			url: `/v1/collections/${ownerCollectionId}/photos/${photoId}`,
			headers: { cookie: memberCookie },
		});
		expect(removed.statusCode).toBe(204);
		const original = await setupPool.query<{ count: number }>(
			"SELECT count(*)::int AS count FROM photos WHERE id = $1",
			[photoId],
		);
		expect(original.rows[0]?.count).toBe(1);

		const archived = await app.inject({
			method: "POST",
			url: `/v1/collections/${ownerCollectionId}/archive`,
			headers: { cookie: memberCookie },
		});
		expect(archived.statusCode).toBe(200);
		const archivedList = await app.inject({
			method: "GET",
			url: "/v1/collections?state=archived",
			headers: { cookie: memberCookie },
		});
		expect(
			archivedList
				.json()
				.data.some((album: { id: string }) => album.id === ownerCollectionId),
		).toBe(true);
		const restored = await app.inject({
			method: "POST",
			url: `/v1/collections/${ownerCollectionId}/restore`,
			headers: { cookie: memberCookie },
		});
		expect(restored.statusCode).toBe(200);

		const previousStorage = config.r2;
		config.r2 = {
			endpoint: "https://test-account.r2.cloudflarestorage.com",
			accessKeyId: "test-access-key",
			secretAccessKey: "test-secret-key",
			bucket: "test-bucket",
		};
		let uploadedPhotoId: string | undefined;
		try {
			const upload = await app.inject({
				method: "POST",
				url: `/v1/collections/${ownerCollectionId}/uploads`,
				headers: { cookie: memberCookie },
				payload: {
					fileName: "member-upload.jpg",
					byteSize: 10,
					contentType: "image/jpeg",
				},
			});
			expect(upload.statusCode).toBe(201);
			uploadedPhotoId = upload.json().data.photoId;
			const uploaded = await setupPool.query<{ uploadedByUserId: string }>(
				'SELECT uploaded_by_user_id AS "uploadedByUserId" FROM photos WHERE id = $1',
				[uploadedPhotoId],
			);
			expect(uploaded.rows[0]?.uploadedByUserId).toBe(memberId);
		} finally {
			config.r2 = previousStorage;
			if (uploadedPhotoId)
				await setupPool.query("DELETE FROM photos WHERE id = $1", [
					uploadedPhotoId,
				]);
		}
	});

	it("stores the album event date and supports scoped gallery views", async () => {
		const eventDate = "2026-09-05";
		const updated = await app.inject({
			method: "PATCH",
			url: `/v1/collections/${collectionId}`,
			headers: { cookie: memberCookie },
			payload: { eventDate },
		});
		expect(updated.statusCode).toBe(200);
		expect(updated.json().data.eventDate).toBe(eventDate);

		const filteredAlbums = await app.inject({
			method: "GET",
			url: "/v1/collections?q=Member&dateFrom=2026-09-01&dateTo=2026-09-30",
			headers: { cookie: memberCookie },
		});
		expect(filteredAlbums.statusCode).toBe(200);
		expect(
			filteredAlbums.json().data.map((album: { id: string }) => album.id),
		).toContain(collectionId);
		const noMatch = await app.inject({
			method: "GET",
			url: "/v1/collections?q=does-not-exist",
			headers: { cookie: memberCookie },
		});
		expect(noMatch.json().data).toEqual([]);

		const uploaders = await app.inject({
			method: "GET",
			url: `/v1/collections/${collectionId}/uploaders`,
			headers: { cookie: memberCookie },
		});
		expect(uploaders.statusCode).toBe(200);
		expect(uploaders.json().data).toEqual([
			expect.objectContaining({ id: memberId, photoCount: 1 }),
		]);

		const images = await app.inject({
			method: "GET",
			url: `/v1/collections/${collectionId}/photos?sort=captured_desc&media=image&uploaderId=${memberId}`,
			headers: { cookie: memberCookie },
		});
		expect(images.statusCode).toBe(200);
		expect(images.json().data.map((photo: { id: string }) => photo.id)).toEqual(
			[photoId],
		);
		for (const sort of [
			"captured_asc",
			"uploaded_asc",
			"uploaded_desc",
			"alphabet_asc",
			"alphabet_desc",
		]) {
			const sorted = await app.inject({
				method: "GET",
				url: `/v1/collections/${collectionId}/photos?sort=${sort}`,
				headers: { cookie: memberCookie },
			});
			expect(sorted.statusCode).toBe(200);
			expect(sorted.json().data).toHaveLength(1);
		}

		const videos = await app.inject({
			method: "GET",
			url: `/v1/collections/${collectionId}/photos?media=video`,
			headers: { cookie: memberCookie },
		});
		expect(videos.statusCode).toBe(200);
		expect(videos.json().data).toEqual([]);
	});

	it("lets a member choose an album thumbnail without changing the photo", async () => {
		const selected = await app.inject({
			method: "PUT",
			url: `/v1/collections/${collectionId}/cover`,
			headers: { cookie: memberCookie },
			payload: { photoId },
		});
		expect(selected.statusCode).toBe(200);
		expect(selected.json().data.coverPhotoId).toBe(photoId);
		const stored = await setupPool.query<{
			coverPhotoId: string;
			photoCount: number;
		}>(
			`SELECT c.cover_photo_id AS "coverPhotoId",
			 (SELECT count(*)::int FROM photos WHERE id = $2) AS "photoCount"
			 FROM collections c WHERE c.id = $1`,
			[collectionId, photoId],
		);
		expect(stored.rows[0]).toEqual({ coverPhotoId: photoId, photoCount: 1 });
	});

	it("rejects unsupported gallery controls", async () => {
		for (const query of ["sort=random", "media=audio", "uploaderId=invalid"]) {
			const response = await app.inject({
				method: "GET",
				url: `/v1/collections/${collectionId}/photos?${query}`,
				headers: { cookie: memberCookie },
			});
			expect(response.statusCode).toBe(400);
			expect(response.json().error.code).toBe("VALIDATION_ERROR");
		}
	});

	it("rejects an invalid album date range", async () => {
		const response = await app.inject({
			method: "GET",
			url: "/v1/collections?dateFrom=2026-10-01&dateTo=2026-09-01",
			headers: { cookie: memberCookie },
		});
		expect(response.statusCode).toBe(400);
		expect(response.json().error.code).toBe("VALIDATION_ERROR");
	});

	it("keeps Loved private per user", async () => {
		const owner = await app.inject({
			method: "GET",
			url: "/v1/loved",
			headers: { cookie: ownerCookie },
		});
		const member = await app.inject({
			method: "GET",
			url: "/v1/loved",
			headers: { cookie: memberCookie },
		});
		expect(owner.json().data).toHaveLength(1);
		expect(owner.json().data[0].loved).toBe(true);
		expect(member.json().data).toHaveLength(0);
	});

	it("supports private Loved gallery controls", async () => {
		const uploaders = await app.inject({
			method: "GET",
			url: "/v1/loved/uploaders",
			headers: { cookie: ownerCookie },
		});
		expect(uploaders.statusCode).toBe(200);
		expect(uploaders.json().data).toEqual([
			expect.objectContaining({ id: memberId, photoCount: 1 }),
		]);

		const filtered = await app.inject({
			method: "GET",
			url: `/v1/loved?sort=alphabet_asc&media=image&uploaderId=${memberId}`,
			headers: { cookie: ownerCookie },
		});
		expect(filtered.statusCode).toBe(200);
		expect(
			filtered.json().data.map((photo: { id: string }) => photo.id),
		).toEqual([photoId]);

		const videos = await app.inject({
			method: "GET",
			url: "/v1/loved?media=video",
			headers: { cookie: ownerCookie },
		});
		expect(videos.statusCode).toBe(200);
		expect(videos.json().data).toEqual([]);

		for (const query of ["sort=random", "media=audio", "uploaderId=invalid"]) {
			const response = await app.inject({
				method: "GET",
				url: `/v1/loved?${query}`,
				headers: { cookie: ownerCookie },
			});
			expect(response.statusCode).toBe(400);
			expect(response.json().error.code).toBe("VALIDATION_ERROR");
		}
	});

	it("archives and restores a member-owned collection without altering its photo", async () => {
		const archived = await app.inject({
			method: "POST",
			url: `/v1/collections/${collectionId}/archive`,
			headers: { cookie: memberCookie },
		});
		expect(archived.statusCode).toBe(200);
		const counts = await setupPool.query<{ links: number; photos: number }>(
			`SELECT (SELECT count(*)::int FROM collection_photos WHERE collection_id=$1) AS links,
			 (SELECT count(*)::int FROM photos WHERE id=$2) AS photos`,
			[collectionId, photoId],
		);
		expect(counts.rows[0]).toEqual({ links: 1, photos: 1 });
		const restored = await app.inject({
			method: "POST",
			url: `/v1/collections/${collectionId}/restore`,
			headers: { cookie: ownerCookie },
		});
		expect(restored.statusCode).toBe(200);
		expect(restored.json().data.archivedAt).toBeNull();
	});
});
