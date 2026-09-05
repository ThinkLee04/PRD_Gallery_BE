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
import { requireApprovedMember } from "../memberships/service.js";

interface AdminCursor {
	v: 1;
	createdAt: string;
	id: string;
}

export async function registerAdminModule(
	app: FastifyInstance,
	config: AppConfig,
): Promise<void> {
	app.get("/v1/admin/pending-users", async (request) => {
		const member = await requireApprovedMember(request, config);
		if (!member.isAdmin)
			throw new ApiError(ErrorCodes.NOT_FOUND, "Resource not found.");
		const query = request.query as { cursor?: string; limit?: string };
		const limit = pageLimit(query.limit, 50, 100);
		const cursor = decodeCursor<AdminCursor>(query.cursor);
		if (
			cursor !== null &&
			(cursor.v !== 1 || !isIsoDate(cursor.createdAt) || !isUuid(cursor.id))
		)
			throw new ApiError(
				ErrorCodes.VALIDATION_ERROR,
				"Invalid pagination cursor.",
			);
		const pool = getPool(config);
		if (pool === null)
			throw new ApiError(ErrorCodes.INTERNAL_ERROR, "Database unavailable.");
		const result = await pool.query<{
			id: string;
			email: string;
			displayName: string;
			avatarUrl: string | null;
			createdAt: string;
		}>(
			`SELECT id, email, display_name AS "displayName", avatar_url AS "avatarUrl", created_at AS "createdAt"
			 FROM users WHERE approval_status = 'PENDING'
			 AND ($1::timestamptz IS NULL OR (created_at, id) > ($1::timestamptz, $2::uuid))
			 ORDER BY created_at, id LIMIT $3`,
			[cursor?.createdAt ?? null, cursor?.id ?? null, limit + 1],
		);
		const hasMore = result.rows.length > limit;
		const rows = result.rows.slice(0, limit);
		const last = rows.at(-1);
		return {
			data: rows,
			page: {
				nextCursor:
					hasMore && last
						? encodeCursor({ v: 1, createdAt: last.createdAt, id: last.id })
						: null,
			},
		};
	});

	app.post(
		"/v1/admin/users/:userId/approve",
		{
			schema: {
				params: Type.Object({ userId: Type.String({ format: "uuid" }) }),
			},
		},
		async (request) => {
			const member = await requireApprovedMember(request, config);
			if (!member.isAdmin)
				throw new ApiError(ErrorCodes.NOT_FOUND, "Resource not found.");
			const { userId } = request.params as { userId: string };
			const pool = getPool(config);
			if (pool === null)
				throw new ApiError(ErrorCodes.INTERNAL_ERROR, "Database unavailable.");
			const client = await pool.connect();
			try {
				await client.query("BEGIN");
				const updated = await client.query(
					`UPDATE users SET approval_status = 'APPROVED', approved_at = COALESCE(approved_at, now()),
				 approved_by_user_id = $2, updated_at = now() WHERE id = $1 RETURNING id`,
					[userId, member.userId],
				);
				if (updated.rowCount === 0)
					throw new ApiError(ErrorCodes.NOT_FOUND, "User not found.");
				await client.query(
					`INSERT INTO vault_memberships (vault_id, user_id, role, invited_by_user_id)
				 VALUES ($1, $2, 'MEMBER', $3) ON CONFLICT (vault_id, user_id) DO NOTHING`,
					[member.vaultId, userId, member.userId],
				);
				await client.query("COMMIT");
				return { data: { id: userId, approvalStatus: "APPROVED" } };
			} catch (error) {
				await client.query("ROLLBACK").catch(() => undefined);
				throw error;
			} finally {
				client.release();
			}
		},
	);
}
