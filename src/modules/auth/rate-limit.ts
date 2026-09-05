import type { FastifyReply, FastifyRequest } from "fastify";
import { ApiError, ErrorCodes } from "../../lib/errors.js";

export interface RateLimitOptions {
	max: number;
	windowMs: number;
}

export function createRateLimiter(options: RateLimitOptions) {
	const { max, windowMs } = options;
	const hits = new Map<string, number[]>();

	return function checkRateLimit(key: string, now = Date.now()): void {
		const cutoff = now - windowMs;
		const recent = (hits.get(key) ?? []).filter(
			(timestamp) => timestamp > cutoff,
		);
		if (recent.length >= max) {
			hits.set(key, recent);
			throw new ApiError(
				ErrorCodes.RATE_LIMITED,
				"Too many attempts. Try again later.",
			);
		}
		recent.push(now);
		hits.set(key, recent);
	};
}

/**
 * Minimal single-instance in-memory sliding-window limiter for the OAuth
 * endpoints (spec §12). A shared auth plugin is deliberately not introduced;
 * vaults/photos rate limiting can be added later where needed.
 */
export function createRateLimitHook(options: RateLimitOptions) {
	const checkRateLimit = createRateLimiter(options);

	return async function rateLimitHook(
		request: FastifyRequest,
		_reply: FastifyReply,
	): Promise<void> {
		checkRateLimit(request.ip ?? "unknown");
	};
}
