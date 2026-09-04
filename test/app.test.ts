import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import { closePool } from "../src/db/pool.js";

const TEST_CONFIG: AppConfig = {
	nodeEnv: "test",
	host: "127.0.0.1",
	port: 0,
	corsOrigin: "http://localhost:5173",
	databaseUrl: null, // no database in these tests -> readiness reports not_configured
};

describe("HTTP API base structure", () => {
	let app: FastifyInstance;

	afterEach(async () => {
		await app?.close();
		await closePool();
	});

	it("GET /health returns 200 with the standard data envelope", async () => {
		app = await buildApp(TEST_CONFIG);
		const res = await app.inject({ method: "GET", url: "/health" });
		expect(res.statusCode).toBe(200);
		const body = res.json();
		expect(body.data).toMatchObject({
			status: "ok",
			service: "photo-vault-api",
		});
		expect(typeof body.data.uptimeSeconds).toBe("number");
		expect(new Date(body.data.timestamp).toString()).not.toBe("Invalid Date");
	});

	it("GET /ready reports not_ready/not_configured (503) when no database is configured", async () => {
		app = await buildApp(TEST_CONFIG);
		const res = await app.inject({ method: "GET", url: "/ready" });
		expect(res.statusCode).toBe(503);
		expect(res.json()).toEqual({
			data: { status: "not_ready", database: "not_configured" },
		});
	});

	it("unknown routes return the stable 404 error envelope with a requestId", async () => {
		app = await buildApp(TEST_CONFIG);
		const res = await app.inject({ method: "GET", url: "/v1/does-not-exist" });
		expect(res.statusCode).toBe(404);
		const body = res.json();
		expect(body.error.code).toBe("NOT_FOUND");
		expect(body.error.requestId).toBeTruthy();
		expect(body.error.message).toBe("Resource not found.");
	});
});
