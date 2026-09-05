import { ApiError, ErrorCodes } from "./errors.js";

const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
	return typeof value === "string" && UUID_PATTERN.test(value);
}

export function isIsoDate(value: unknown): value is string {
	return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

export function encodeCursor(value: object): string {
	return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export function decodeCursor<T>(raw: string | undefined): T | null {
	if (raw === undefined || raw === "") return null;
	try {
		const value: unknown = JSON.parse(
			Buffer.from(raw, "base64url").toString("utf8"),
		);
		if (value === null || typeof value !== "object" || Array.isArray(value))
			throw new Error("invalid");
		return value as T;
	} catch {
		throw new ApiError(
			ErrorCodes.VALIDATION_ERROR,
			"Invalid pagination cursor.",
		);
	}
}

export function pageLimit(raw: unknown, fallback = 40, maximum = 80): number {
	if (raw === undefined) return fallback;
	const value =
		typeof raw === "string" ? Number.parseInt(raw, 10) : Number(raw);
	if (!Number.isInteger(value) || value < 1 || value > maximum) {
		throw new ApiError(
			ErrorCodes.VALIDATION_ERROR,
			`limit must be between 1 and ${maximum}.`,
		);
	}
	return value;
}
