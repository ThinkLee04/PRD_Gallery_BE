import { describe, expect, it } from "vitest";
import { createRateLimiter } from "../src/modules/auth/rate-limit.js";

describe("rate limiter", () => {
	it("limits each key independently and releases hits after the window", () => {
		const check = createRateLimiter({ max: 2, windowMs: 1_000 });
		check("member-a", 1_000);
		check("member-a", 1_100);
		expect(() => check("member-a", 1_200)).toThrowError(/Too many attempts/);
		expect(() => check("member-b", 1_200)).not.toThrow();
		expect(() => check("member-a", 2_101)).not.toThrow();
	});
});
