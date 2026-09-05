import type pg from "pg";
import type { AppConfig } from "../../config.js";
import { isUuid } from "../../lib/cursor.js";
import { signDownload } from "../uploads/storage.js";

export interface GalleryRow {
	id: string;
	mediaType: "IMAGE" | "VIDEO";
	status: "PENDING_UPLOAD" | "UPLOADED" | "PROCESSING" | "READY" | "FAILED";
	fileName: string;
	width: number | null;
	height: number | null;
	capturedAt: string | null;
	capturedTimezoneOffsetMinutes: number | null;
	uploadedAt: string;
	uploaderId: string;
	uploaderName: string;
	uploaderAvatarUrl: string | null;
	loved: boolean;
	smKey: string | null;
	smWidth: number | null;
	smHeight: number | null;
	mdKey: string | null;
	mdWidth: number | null;
	mdHeight: number | null;
}

export async function toGalleryItem(config: AppConfig, row: GalleryRow) {
	const asset = async (
		key: string | null,
		width: number | null,
		height: number | null,
	) => {
		if (key === null || width === null || height === null || config.r2 === null)
			return null;
		const signed = await signDownload(config, key);
		return { ...signed, width, height };
	};
	const [sm, md] = await Promise.all([
		asset(row.smKey, row.smWidth, row.smHeight),
		asset(row.mdKey, row.mdWidth, row.mdHeight),
	]);
	return {
		id: row.id,
		mediaType: row.mediaType,
		status: row.status,
		fileName: row.fileName,
		width: row.width,
		height: row.height,
		aspectRatio:
			row.width !== null && row.height !== null ? row.width / row.height : null,
		capturedAt: row.capturedAt,
		capturedTimezoneOffsetMinutes: row.capturedTimezoneOffsetMinutes,
		uploadedAt: row.uploadedAt,
		uploader: {
			id: row.uploaderId,
			displayName: row.uploaderName,
			avatarUrl: row.uploaderAvatarUrl,
		},
		loved: row.loved,
		assets: { sm, md },
	};
}

export function gallerySelect(userParameter: string): string {
	return `p.id, p.media_type AS "mediaType", p.status,
	 p.original_filename AS "fileName", p.width, p.height, p.captured_at AS "capturedAt",
	 p.captured_timezone_offset_minutes AS "capturedTimezoneOffsetMinutes", p.created_at AS "uploadedAt",
	 u.id AS "uploaderId", u.display_name AS "uploaderName", u.avatar_url AS "uploaderAvatarUrl",
	 EXISTS (SELECT 1 FROM favorites f0 WHERE f0.user_id = ${userParameter} AND f0.photo_id = p.id) AS loved,
	 sm.object_key AS "smKey", sm.width AS "smWidth", sm.height AS "smHeight",
	 md.object_key AS "mdKey", md.width AS "mdWidth", md.height AS "mdHeight"`;
}

export function galleryJoins(): string {
	return `JOIN users u ON u.id = p.uploaded_by_user_id
	 LEFT JOIN photo_assets sm ON sm.photo_id = p.id AND sm.kind = 'THUMBNAIL_SM'
	 LEFT JOIN photo_assets md ON md.photo_id = p.id AND md.kind = 'THUMBNAIL_MD'`;
}

export async function findAccessiblePhoto(
	pool: pg.Pool,
	vaultId: string,
	photoId: string,
) {
	if (!isUuid(photoId)) return null;
	const result = await pool.query<{
		id: string;
		uploadedByUserId: string;
		objectKey: string;
		fileName: string;
		status: string;
		mediaType: string;
	}>(
		`SELECT id, uploaded_by_user_id AS "uploadedByUserId", original_object_key AS "objectKey",
		 original_filename AS "fileName", status, media_type AS "mediaType"
		 FROM photos WHERE id = $1 AND vault_id = $2`,
		[photoId, vaultId],
	);
	return result.rows[0] ?? null;
}
