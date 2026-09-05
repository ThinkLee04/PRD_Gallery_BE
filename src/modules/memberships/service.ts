import type { FastifyRequest } from "fastify";
import type pg from "pg";
import type { AppConfig } from "../../config.js";
import { isUuid } from "../../lib/cursor.js";
import { ApiError, ErrorCodes } from "../../lib/errors.js";
import { requireUser } from "../auth/session.js";

export type VaultRole = "OWNER" | "MEMBER";

export interface ApprovedMember {
	userId: string;
	vaultId: string;
	vaultName: string;
	role: VaultRole;
	isAdmin: boolean;
}

export async function bootstrapUserAccess(
	pool: pg.Pool,
	input: {
		userId: string;
		email: string;
		adminEmails: readonly string[];
		vaultName: string;
	},
): Promise<void> {
	const isAdmin = input.adminEmails.includes(input.email.toLowerCase());
	if (!isAdmin) {
		await pool.query(
			"UPDATE users SET is_app_admin = false, updated_at = now() WHERE id = $1 AND is_app_admin",
			[input.userId],
		);
		return;
	}
	const client = await pool.connect();
	try {
		await client.query("BEGIN");
		await client.query(
			`UPDATE users SET approval_status = 'APPROVED', approved_at = COALESCE(approved_at, now()),
			 is_app_admin = true, updated_at = now() WHERE id = $1`,
			[input.userId],
		);
		const vault = await client.query<{ id: string }>(
			`INSERT INTO vaults (name, created_by_user_id) VALUES ($1, $2)
			 ON CONFLICT (singleton_key) DO UPDATE SET singleton_key = EXCLUDED.singleton_key
			 RETURNING id`,
			[input.vaultName, input.userId],
		);
		const vaultId = vault.rows[0]?.id;
		if (vaultId === undefined) throw new Error("Unable to bootstrap vault.");
		await client.query(
			`INSERT INTO vault_memberships (vault_id, user_id, role) VALUES ($1, $2, 'OWNER')
			 ON CONFLICT (vault_id, user_id) DO UPDATE SET role = 'OWNER'`,
			[vaultId, input.userId],
		);
		await client.query("COMMIT");
	} catch (error) {
		await client.query("ROLLBACK").catch(() => undefined);
		throw error;
	} finally {
		client.release();
	}
}

export async function requireApprovedMember(
	request: FastifyRequest,
	config: AppConfig,
): Promise<ApprovedMember> {
	const user = await requireUser(request, config);
	if (user.approvalStatus !== "APPROVED") {
		throw new ApiError(
			ErrorCodes.FORBIDDEN,
			"Your account is awaiting approval.",
		);
	}
	if (user.vaultId === null || user.vaultRole === null) {
		throw new ApiError(ErrorCodes.NOT_FOUND, "Resource not found.");
	}
	return {
		userId: user.id,
		vaultId: user.vaultId,
		vaultName: user.vaultName ?? "Photo Vault",
		role: user.vaultRole,
		isAdmin: user.isAdmin,
	};
}

export function canManageCollection(
	member: ApprovedMember,
	createdByUserId: string,
): boolean {
	return member.role === "OWNER" || member.userId === createdByUserId;
}

export async function requireCollection(
	pool: pg.Pool,
	member: ApprovedMember,
	collectionId: string,
	options: { includeArchived?: boolean; manage?: boolean } = {},
): Promise<{
	id: string;
	vaultId: string;
	createdByUserId: string;
	orderVersion: string;
	archivedAt: string | null;
}> {
	if (!isUuid(collectionId)) {
		throw new ApiError(ErrorCodes.NOT_FOUND, "Collection not found.");
	}
	const result = await pool.query<{
		id: string;
		vaultId: string;
		createdByUserId: string;
		orderVersion: string;
		archivedAt: string | null;
	}>(
		`SELECT id, vault_id AS "vaultId", created_by_user_id AS "createdByUserId",
		 order_version::text AS "orderVersion", archived_at AS "archivedAt"
		 FROM collections WHERE id = $1 AND vault_id = $2`,
		[collectionId, member.vaultId],
	);
	const collection = result.rows[0];
	if (
		collection === undefined ||
		(!options.includeArchived && collection.archivedAt !== null)
	) {
		throw new ApiError(ErrorCodes.NOT_FOUND, "Collection not found.");
	}
	if (
		options.manage &&
		!canManageCollection(member, collection.createdByUserId)
	) {
		throw new ApiError(ErrorCodes.NOT_FOUND, "Collection not found.");
	}
	return collection;
}
