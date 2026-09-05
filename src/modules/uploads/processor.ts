import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import * as exifr from "exifr";
import { fileTypeFromBuffer } from "file-type";
import type pg from "pg";
import type { AppConfig } from "../../config.js";
import { readObject, writeAsset } from "./storage.js";

const execFileAsync = promisify(execFile);
let running = false;
let sharpPromise: Promise<typeof import("sharp") | null> | null = null;

async function loadSharp(): Promise<typeof import("sharp") | null> {
	sharpPromise ??= import("sharp").catch(() => null);
	return sharpPromise;
}

export function hasFfprobe(): boolean {
	try {
		execFileSync("ffprobe", ["-version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

export async function canProcessUpload(
	mediaType: "IMAGE" | "VIDEO",
	contentType: string,
): Promise<boolean> {
	if (mediaType === "VIDEO") return hasFfprobe();
	const sharpModule = await loadSharp();
	if (sharpModule === null) return false;
	if (["image/heic", "image/heif"].includes(contentType))
		return sharpModule.default.versions.heif !== undefined;
	return true;
}

interface PendingPhoto {
	id: string;
	vaultId: string;
	objectKey: string;
	mediaType: "IMAGE" | "VIDEO";
	contentType: string;
}

async function extractVideo(
	buffer: Buffer,
): Promise<{ width: number; height: number; capturedAt: Date | null }> {
	const dir = await mkdtemp(join(tmpdir(), "photo-vault-"));
	const path = join(dir, "original");
	try {
		await writeFile(path, buffer);
		const { stdout } = await execFileAsync(
			"ffprobe",
			[
				"-v",
				"error",
				"-select_streams",
				"v:0",
				"-show_entries",
				"stream=width,height:format_tags=creation_time",
				"-of",
				"json",
				path,
			],
			{ maxBuffer: 1024 * 1024 },
		);
		const parsed = JSON.parse(stdout) as {
			streams?: Array<{ width?: number; height?: number }>;
			format?: { tags?: { creation_time?: string } };
		};
		const stream = parsed.streams?.[0];
		if (!stream?.width || !stream.height)
			throw new Error("VIDEO_DIMENSIONS_UNAVAILABLE");
		const rawDate = parsed.format?.tags?.creation_time;
		const capturedAt =
			rawDate && !Number.isNaN(Date.parse(rawDate)) ? new Date(rawDate) : null;
		return { width: stream.width, height: stream.height, capturedAt };
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

async function processPhoto(
	pool: pg.Pool,
	config: AppConfig,
	photo: PendingPhoto,
): Promise<void> {
	const buffer = await readObject(config, photo.objectKey);
	const detected = await fileTypeFromBuffer(buffer);
	const imageMimes = new Set([
		"image/jpeg",
		"image/png",
		"image/webp",
		"image/heic",
		"image/heif",
	]);
	const videoMimes = new Set(["video/mp4", "video/quicktime"]);
	if (
		detected === undefined ||
		(photo.mediaType === "IMAGE"
			? !imageMimes.has(detected.mime)
			: !videoMimes.has(detected.mime))
	) {
		throw new Error("UNSUPPORTED_MEDIA_SIGNATURE");
	}

	if (photo.mediaType === "VIDEO") {
		const metadata = await extractVideo(buffer);
		await pool.query(
			`UPDATE photos SET width = $2, height = $3, captured_at = $4, status = 'READY',
			 content_type = $5, processing_error_code = NULL, updated_at = now() WHERE id = $1`,
			[
				photo.id,
				metadata.width,
				metadata.height,
				metadata.capturedAt,
				detected.mime,
			],
		);
		return;
	}

	const sharpModule = await loadSharp();
	if (sharpModule === null) throw new Error("IMAGE_PROCESSOR_UNAVAILABLE");
	const sharp = sharpModule.default;
	const source = sharp(buffer, { failOn: "error" }).rotate();
	const metadata = await source.metadata();
	const exif = (await exifr
		.parse(buffer, ["DateTimeOriginal", "CreateDate", "OffsetTimeOriginal"])
		.catch(() => null)) as {
		DateTimeOriginal?: Date;
		CreateDate?: Date;
		OffsetTimeOriginal?: string;
	} | null;
	const capturedAt = exif?.DateTimeOriginal ?? exif?.CreateDate ?? null;
	const offsetMatch = exif?.OffsetTimeOriginal?.match(
		/^([+-])(\d{2}):(\d{2})$/,
	);
	const capturedOffset = offsetMatch
		? (offsetMatch[1] === "-" ? -1 : 1) *
			(Number(offsetMatch[2]) * 60 + Number(offsetMatch[3]))
		: null;
	if (!metadata.width || !metadata.height)
		throw new Error("IMAGE_DIMENSIONS_UNAVAILABLE");
	for (const variant of [
		{ kind: "THUMBNAIL_SM", width: 480, suffix: "thumb-sm.webp" },
		{ kind: "THUMBNAIL_MD", width: 1280, suffix: "thumb-md.webp" },
		{ kind: "DISPLAY", width: 2560, suffix: "display.webp" },
	] as const) {
		const output = await sharp(buffer)
			.rotate()
			.resize({ width: variant.width, withoutEnlargement: true })
			.webp({ quality: 82 })
			.toBuffer({ resolveWithObject: true });
		const key = `vaults/${photo.vaultId}/photos/${photo.id}/${variant.suffix}`;
		await writeAsset(config, key, output.data);
		await pool.query(
			`INSERT INTO photo_assets (photo_id, kind, object_key, content_type, byte_size, width, height)
			 VALUES ($1, $2, $3, 'image/webp', $4, $5, $6)
			 ON CONFLICT (photo_id, kind) DO UPDATE SET object_key = EXCLUDED.object_key,
			 byte_size = EXCLUDED.byte_size, width = EXCLUDED.width, height = EXCLUDED.height`,
			[
				photo.id,
				variant.kind,
				key,
				output.data.byteLength,
				output.info.width,
				output.info.height,
			],
		);
	}
	await pool.query(
		`UPDATE photos SET width = $2, height = $3, status = 'READY', content_type = $4,
		 captured_at = $5, captured_timezone_offset_minutes = $6,
		 processing_error_code = NULL, updated_at = now() WHERE id = $1`,
		[
			photo.id,
			metadata.autoOrient.width,
			metadata.autoOrient.height,
			detected.mime,
			capturedAt,
			capturedOffset,
		],
	);
}

export function triggerProcessing(pool: pg.Pool, config: AppConfig): void {
	if (running || config.r2 === null) return;
	running = true;
	void (async () => {
		try {
			while (true) {
				const claim = await pool.query<PendingPhoto>(
					`UPDATE photos SET status = 'PROCESSING', processing_attempts = processing_attempts + 1, updated_at = now()
					 WHERE id = (SELECT id FROM photos WHERE status IN ('UPLOADED', 'PROCESSING')
					 AND (status = 'UPLOADED' OR updated_at < now() - interval '5 minutes') ORDER BY updated_at, id LIMIT 1 FOR UPDATE SKIP LOCKED)
					 RETURNING id, vault_id AS "vaultId", original_object_key AS "objectKey", media_type AS "mediaType", content_type AS "contentType"`,
				);
				const photo = claim.rows[0];
				if (photo === undefined) break;
				try {
					await processPhoto(pool, config, photo);
				} catch (error) {
					const code =
						error instanceof Error
							? error.message.slice(0, 120)
							: "PROCESSING_FAILED";
					await pool.query(
						"UPDATE photos SET status = 'FAILED', processing_error_code = $2, updated_at = now() WHERE id = $1",
						[photo.id, code],
					);
				}
			}
		} finally {
			running = false;
		}
	})();
}
