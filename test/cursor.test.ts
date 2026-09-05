import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor, pageLimit } from "../src/lib/cursor.js";

describe("cursor helpers", () => {
	it("round-trips opaque cursor state", () => {
		const value = { v: 1, position: "42", photoId: "photo" };
		expect(decodeCursor(encodeCursor(value))).toEqual(value);
	});

	it("rejects malformed cursors and out-of-range limits", () => {
		expect(() => decodeCursor("not-json")).toThrow(/cursor/i);
		expect(() => pageLimit("0")).toThrow(/between 1 and 80/i);
		expect(() => pageLimit("81")).toThrow(/between 1 and 80/i);
	});
});
