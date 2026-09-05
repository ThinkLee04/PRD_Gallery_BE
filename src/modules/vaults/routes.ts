import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../../config.js";
import { requireApprovedMember } from "../memberships/service.js";

export async function registerVaultModule(
	app: FastifyInstance,
	config: AppConfig,
): Promise<void> {
	app.get("/v1/vault", async (request) => {
		const member = await requireApprovedMember(request, config);
		return {
			data: { id: member.vaultId, name: member.vaultName, role: member.role },
		};
	});
}
