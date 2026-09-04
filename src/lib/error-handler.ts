import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import { type ErrorCode, ErrorCodes, errorCodeToStatus } from "./errors.js";

interface ErrorBody {
	error: {
		code: ErrorCode;
		message: string;
		requestId: string;
	};
}

/**
 * Central Fastify error handler. Formats domain errors (ApiError), Fastify
 * schema/validation errors, and unexpected errors into the standard envelope.
 * Unexpected errors are logged with their cause but exposed as INTERNAL_ERROR
 * with a generic message.
 */
export function errorHandler(
	error: FastifyError,
	request: FastifyRequest,
	reply: FastifyReply,
): void {
	const requestId = request.id;

	if (error.name === "ApiError" && typeof error.code === "string") {
		const code = error.code as ErrorCode;
		const body: ErrorBody = {
			error: { code, message: error.message, requestId },
		};
		void reply.code(errorCodeToStatus(code)).send(body);
		return;
	}

	// Fastify validation errors carry a "validation" property and status 400.
	if (error.validation !== undefined) {
		const body: ErrorBody = {
			error: {
				code: ErrorCodes.VALIDATION_ERROR,
				message: error.message,
				requestId,
			},
		};
		void reply.code(400).send(body);
		return;
	}

	request.log.error({ err: error }, "unhandled error");
	const body: ErrorBody = {
		error: {
			code: ErrorCodes.INTERNAL_ERROR,
			message: "An internal error occurred.",
			requestId,
		},
	};
	void reply.code(500).send(body);
}
