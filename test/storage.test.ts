import { describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config.js";
import { signDownload, signUpload } from "../src/modules/uploads/storage.js";

const config = {
	nodeEnv: "test",
	r2: {
		endpoint: "https://account.r2.cloudflarestorage.com",
		accessKeyId: "test-access-key",
		secretAccessKey: "never-expose-this-secret",
		bucket: "private-photos",
	},
	r2UploadUrlTtlSeconds: 1800,
	r2DownloadUrlTtlSeconds: 600,
} as AppConfig;

describe("R2 signed URL boundary", () => {
	it("signs a write-once upload with exact browser headers", async () => {
		const result = await signUpload(
			config,
			"vaults/v/photos/p/original",
			"image/jpeg",
		);
		expect(result.url).toContain("X-Amz-Signature=");
		expect(result.url).not.toContain(config.r2?.secretAccessKey);
		expect(result.headers).toEqual({
			"content-type": "image/jpeg",
			"if-none-match": "*",
		});
	});

	it("signs one private object without exposing the secret", async () => {
		const result = await signDownload(config, "vaults/v/photos/p/display.webp");
		expect(result.url).toContain("X-Amz-Expires=600");
		expect(result.url).not.toContain(config.r2?.secretAccessKey);
	});
});
