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
		photoId = (
			await setupPool.query<{ id: string }>(
				`INSERT INTO photos (vault_id, uploaded_by_user_id, media_type, status, original_object_key, original_filename, content_type, byte_size, width, height)
			 VALUES ($1,$2,'IMAGE','READY',$3,'photo.jpg','image/jpeg',10,100,100) RETURNING id`,
				[vaultId, memberId, `vaults/${vaultId}/test-${suffix}`],
			)
		).rows[0]?.id as string;
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
			await setupPool.query("DELETE FROM collections WHERE id = $1", [
				collectionId,
			]);
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
