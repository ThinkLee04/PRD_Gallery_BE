import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../../config.js";
import { checkDatabase } from "../../db/pool.js";
import {
	HealthResponseSchema,
	ReadyOkResponseSchema,
	ReadyUnavailableResponseSchema,
} from "./schemas.js";

/**
 * Public, unauthenticated, non-sensitive health endpoints (spec §14).
 * GET /health  -> liveness (no external dependency)
 * GET /ready   -> readiness (reports database reachability)
 */
export async function registerHealthModule(
	app: FastifyInstance,
	config: AppConfig,
): Promise<void> {
	app.get(
		"/health",
		{ schema: { response: { 200: HealthResponseSchema } } },
		async () => ({
			data: {
				status: "ok",
				service: "photo-vault-api",
				uptimeSeconds: Math.round(process.uptime()),
				timestamp: new Date().toISOString(),
			},
		}),
	);

	app.get(
		"/ready",
		{
			schema: {
				response: {
					200: ReadyOkResponseSchema,
					503: ReadyUnavailableResponseSchema,
				},
			},
		},
		async (_request, reply) => {
			const database = await checkDatabase(config);
			if (database === "ok") {
				return reply
					.code(200)
					.send({ data: { status: "ready", database: "ok" } });
			}
			return reply.code(503).send({ data: { status: "not_ready", database } });
		},
	);
}
