import { describe, expect, it } from "vitest";
import {
	parseCaptureExif,
	selectCaptureMetadata,
} from "../src/modules/uploads/processor.js";

describe("media processor dependencies", () => {
	it("loads the production exifr CommonJS entry through its default export", async () => {
		await expect(parseCaptureExif(Buffer.alloc(0))).resolves.toBeNull();
	});

	it("prefers the original EXIF time and preserves its source offset", () => {
		const result = selectCaptureMetadata(
			{
				DateTimeOriginal: "2024:07:08 19:20:21",
				OffsetTimeOriginal: "+07:00",
				ModifyDate: "2025:01:01 00:00:00",
			},
			"2026-01-01T00:00:00.000Z",
		);
		expect(result).toEqual({
			capturedAt: new Date("2024-07-08T19:20:21+07:00"),
			capturedOffset: 420,
			source: "EXIF_DATE_TIME_ORIGINAL",
		});
	});

	it("uses file modification time only when embedded capture dates are absent", () => {
		const result = selectCaptureMetadata({}, "2023-04-05T06:07:08.000Z");
		expect(result).toEqual({
			capturedAt: new Date("2023-04-05T06:07:08.000Z"),
			capturedOffset: null,
			source: "FILE_LAST_MODIFIED",
		});
	});

	it("reads an offset embedded in an XMP-style create date", () => {
		const result = selectCaptureMetadata(
			{ CreateDate: "2024-07-08T19:20:21+07:00" },
			null,
		);
		expect(result.capturedAt).toEqual(new Date("2024-07-08T19:20:21+07:00"));
		expect(result.capturedOffset).toBe(420);
		expect(result.source).toBe("EXIF_CREATE_DATE");
	});
});
