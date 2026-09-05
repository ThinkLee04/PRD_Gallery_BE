import { Type } from "@sinclair/typebox";

/**
 * Response JSON Schemas (TypeBox) for the auth module. Keep DTOs distinct from
 * raw DB rows (docs/technical-spec.md §16). OAuth start/callback endpoints
 * redirect the browser, so they have no JSON bodies.
 */
export const MeResponseSchema = Type.Object({
	data: Type.Object({
		id: Type.String(),
		email: Type.String(),
		displayName: Type.String(),
		avatarUrl: Type.Union([Type.String(), Type.Null()]),
		approvalStatus: Type.Union([
			Type.Literal("PENDING"),
			Type.Literal("APPROVED"),
		]),
		isAdmin: Type.Boolean(),
		vault: Type.Union([
			Type.Object({
				id: Type.String(),
				name: Type.String(),
				role: Type.Union([Type.Literal("OWNER"), Type.Literal("MEMBER")]),
			}),
			Type.Null(),
		]),
	}),
});
