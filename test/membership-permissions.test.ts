import { describe, expect, it } from "vitest";
import {
	type ApprovedMember,
	canManageCollection,
} from "../src/modules/memberships/service.js";

describe("shared vault collection permissions", () => {
	it("allows an approved member to manage a collection created by someone else", () => {
		const member: ApprovedMember = {
			userId: "member-user",
			vaultId: "shared-vault",
			vaultName: "Photo Vault",
			role: "MEMBER",
			isAdmin: false,
		};

		expect(canManageCollection(member, "another-user")).toBe(true);
	});
});
