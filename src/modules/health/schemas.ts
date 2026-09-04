import { Type } from "@sinclair/typebox";

/**
 * Response JSON Schemas (TypeBox). Fastify validates/serializes route output
 * against these. Keep DTOs distinct from raw DB rows (docs/technical-spec.md §16).
 */
export const HealthResponseSchema = Type.Object({
	data: Type.Object({
		status: Type.Literal("ok"),
		service: Type.Literal("photo-vault-api"),
		uptimeSeconds: Type.Number(),
		timestamp: Type.String(),
	}),
});

export const ReadyOkResponseSchema = Type.Object({
	data: Type.Object({
		status: Type.Literal("ready"),
		database: Type.Literal("ok"),
	}),
});

export const ReadyUnavailableResponseSchema = Type.Object({
	data: Type.Object({
		status: Type.Literal("not_ready"),
		database: Type.Union([
			Type.Literal("unavailable"),
			Type.Literal("not_configured"),
		]),
	}),
});
