import { buildApp } from "./app.js";
import type { AppConfig } from "./config.js";
import { ConfigError, loadConfig } from "./config.js";
import { closePool } from "./db/pool.js";

function loadConfigOrExit(): AppConfig {
	try {
		return loadConfig();
	} catch (err) {
		if (err instanceof ConfigError) {
			console.error(err.message);
		} else {
			console.error("Failed to load configuration:", err);
		}
		process.exit(1);
	}
}

async function main(): Promise<void> {
	const config = loadConfigOrExit();

	const app = await buildApp(config);

	const shutdown = async (signal: string): Promise<void> => {
		app.log.info({ signal }, "shutting down");
		await app.close();
		await closePool();
		process.exit(0);
	};
	process.once("SIGINT", () => void shutdown("SIGINT"));
	process.once("SIGTERM", () => void shutdown("SIGTERM"));

	try {
		// Bind loopback only; Caddy is the public entry point in production.
		await app.listen({ host: config.host, port: config.port });
	} catch (err) {
		app.log.error(err, "failed to start server");
		await closePool();
		process.exit(1);
	}
}

void main();
