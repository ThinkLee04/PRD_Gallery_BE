import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import type { FastifyInstance } from "fastify";
import Fastify from "fastify";
import type { AppConfig } from "./config.js";
import { errorHandler } from "./lib/error-handler.js";
import { ErrorCodes } from "./lib/errors.js";
import { registerAdminModule } from "./modules/admin/index.js";
import { registerAuthModule } from "./modules/auth/index.js";
import { registerCollectionsModule } from "./modules/collections/index.js";
import { registerFavoritesModule } from "./modules/favorites/index.js";
import { registerHealthModule } from "./modules/health/routes.js";
import { registerPhotosModule } from "./modules/photos/index.js";
import { registerUploadsModule } from "./modules/uploads/index.js";
import { registerVaultModule } from "./modules/vaults/index.js";

/**
 * Builds the Fastify application from configuration. Registration order:
 * plugins (CORS) -> error handling -> domain modules.
 */
export async function buildApp(config: AppConfig): Promise<FastifyInstance> {
	const app = Fastify({
		logger:
			config.nodeEnv === "test"
				? false
				: {
						level: "info",
						base: { service: "photo-vault-api" },
						redact: {
							censor: "[REDACTED]",
							paths: [
								"req.headers.authorization",
								"req.headers.cookie",
								"req.query.code",
								"req.query.state",
								'res.headers["set-cookie"]',
							],
						},
					},
		bodyLimit: 1024 * 1024,
	});

	// Narrow CORS: only the frontend origin, with credentials. Never "*".
	await app.register(cors, {
		origin: config.corsOrigin,
		credentials: true,
	});

	// Cookie parsing/serialization for session + OAuth-state cookies.
	await app.register(cookie);

	app.setErrorHandler(errorHandler);
	app.setNotFoundHandler((request, reply) => {
		void reply.code(404).send({
			error: {
				code: ErrorCodes.NOT_FOUND,
				message: "Resource not found.",
				requestId: request.id,
			},
		});
	});

	// Domain modules. Health is always available; auth provides Google login.
	await registerHealthModule(app, config);
	await registerAuthModule(app, config);
	await registerAdminModule(app, config);
	await registerVaultModule(app, config);
	await registerCollectionsModule(app, config);
	await registerPhotosModule(app, config);
	await registerFavoritesModule(app, config);
	await registerUploadsModule(app, config);

	return app;
}
