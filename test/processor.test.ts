import { describe, expect, it } from "vitest";
import { parseCaptureExif } from "../src/modules/uploads/processor.js";

describe("media processor dependencies", () => {
	it("loads the production exifr CommonJS entry through its default export", async () => {
		await expect(parseCaptureExif(Buffer.alloc(0))).resolves.toBeNull();
	});
});
