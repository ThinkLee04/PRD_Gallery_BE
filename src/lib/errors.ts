/**
 * Stable, machine-readable API error codes (docs/technical-spec.md §9).
 * Response bodies are shaped as:
 *   { "error": { "code", "message", "requestId" } }
 */
export const ErrorCodes = {
	UNAUTHENTICATED: "UNAUTHENTICATED",
	FORBIDDEN: "FORBIDDEN",
	NOT_FOUND: "NOT_FOUND",
	VALIDATION_ERROR: "VALIDATION_ERROR",
	CONFLICT: "CONFLICT",
	RATE_LIMITED: "RATE_LIMITED",
	INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

const CODE_TO_STATUS: Record<ErrorCode, number> = {
	UNAUTHENTICATED: 401,
	FORBIDDEN: 403,
	NOT_FOUND: 404,
	VALIDATION_ERROR: 400,
	CONFLICT: 409,
	RATE_LIMITED: 429,
	INTERNAL_ERROR: 500,
};

export function errorCodeToStatus(code: ErrorCode): number {
	return CODE_TO_STATUS[code];
}

/**
 * An error intentionally surfaced to the API client. Throw these from domain
 * logic or handlers; the app error handler serializes them into the standard
 * envelope without leaking stack traces or internals.
 */
export class ApiError extends Error {
	readonly code: ErrorCode;
	readonly statusCode: number;

	constructor(code: ErrorCode, message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "ApiError";
		this.code = code;
		this.statusCode = errorCodeToStatus(code);
	}
}
