import {
	DeleteObjectsCommand,
	GetObjectCommand,
	HeadObjectCommand,
	PutObjectCommand,
	S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { AppConfig } from "../../config.js";
import { ApiError, ErrorCodes } from "../../lib/errors.js";

function storageConfig(config: AppConfig): NonNullable<AppConfig["r2"]> {
	if (config.r2 === null)
		throw new ApiError(
			ErrorCodes.INTERNAL_ERROR,
			"Media storage is unavailable.",
		);
	return config.r2;
}

const clients = new Map<string, S3Client>();
function client(config: AppConfig): S3Client {
	const settings = storageConfig(config);
	let value = clients.get(settings.endpoint);
	if (value === undefined) {
		value = new S3Client({
			region: "auto",
			endpoint: settings.endpoint,
			credentials: {
				accessKeyId: settings.accessKeyId,
				secretAccessKey: settings.secretAccessKey,
			},
		});
		clients.set(settings.endpoint, value);
	}
	return value;
}

export async function signUpload(
	config: AppConfig,
	key: string,
	contentType: string,
): Promise<{
	url: string;
	headers: Record<string, string>;
	expiresAt: string;
}> {
	const settings = storageConfig(config);
	const url = await getSignedUrl(
		client(config),
		new PutObjectCommand({
			Bucket: settings.bucket,
			Key: key,
			ContentType: contentType,
			IfNoneMatch: "*",
		}),
		{ expiresIn: config.r2UploadUrlTtlSeconds },
	);
	return {
		url,
		headers: { "content-type": contentType, "if-none-match": "*" },
		expiresAt: new Date(
			Date.now() + config.r2UploadUrlTtlSeconds * 1000,
		).toISOString(),
	};
}

export async function headObject(
	config: AppConfig,
	key: string,
): Promise<{ byteSize: number; contentType: string | undefined }> {
	const settings = storageConfig(config);
	const result = await client(config).send(
		new HeadObjectCommand({ Bucket: settings.bucket, Key: key }),
	);
	return {
		byteSize: result.ContentLength ?? 0,
		contentType: result.ContentType,
	};
}

export async function readObject(
	config: AppConfig,
	key: string,
): Promise<Buffer> {
	const settings = storageConfig(config);
	const result = await client(config).send(
		new GetObjectCommand({ Bucket: settings.bucket, Key: key }),
	);
	if (result.Body === undefined) throw new Error("R2 object body is missing.");
	return Buffer.from(await result.Body.transformToByteArray());
}

export async function writeAsset(
	config: AppConfig,
	key: string,
	body: Buffer,
): Promise<void> {
	const settings = storageConfig(config);
	await client(config).send(
		new PutObjectCommand({
			Bucket: settings.bucket,
			Key: key,
			Body: body,
			ContentType: "image/webp",
			CacheControl: `private, max-age=${config.r2DownloadUrlTtlSeconds}`,
		}),
	);
}

export async function deleteObjects(
	config: AppConfig,
	keys: readonly string[],
): Promise<void> {
	if (keys.length === 0) return;
	const settings = storageConfig(config);
	const result = await client(config).send(
		new DeleteObjectsCommand({
			Bucket: settings.bucket,
			Delete: {
				Objects: [...new Set(keys)].map((Key) => ({ Key })),
				Quiet: true,
			},
		}),
	);
	if (result.Errors?.length) throw new Error("R2_OBJECT_DELETE_FAILED");
}

export async function signDownload(
	config: AppConfig,
	key: string,
	options: { fileName?: string; download?: boolean } = {},
): Promise<{ url: string; expiresAt: string }> {
	const settings = storageConfig(config);
	const safeName = (options.fileName ?? "media").replace(/["\\\r\n]/g, "_");
	const command = new GetObjectCommand({
		Bucket: settings.bucket,
		Key: key,
		ResponseContentDisposition: `${options.download ? "attachment" : "inline"}; filename="${safeName}"`,
	});
	return {
		url: await getSignedUrl(client(config), command, {
			expiresIn: config.r2DownloadUrlTtlSeconds,
		}),
		expiresAt: new Date(
			Date.now() + config.r2DownloadUrlTtlSeconds * 1000,
		).toISOString(),
	};
}
