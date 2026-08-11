import { describe, expect, it } from "vitest";
import {
	expandProfileToWhopScopes,
	isProfileName,
	PROFILE_NAMES,
} from "../src/profile-scopes.ts";
import { registry } from "../src/registry.ts";

const operations = registry.operations;

describe("profile scopes", () => {
	it("bounds each profile to the scopes its visible operations declare", () => {
		const readOnly = expandProfileToWhopScopes("read_only", operations);
		expect(readOnly).toContain("openid");
		expect(readOnly).toContain("payment:basic:read");
		expect(readOnly).not.toContain("payment:charge");
		expect(readOnly).not.toContain("payment:manage");
		expect(readOnly).not.toContain("payout:withdraw_funds");

		const standard = expandProfileToWhopScopes("standard", operations);
		expect(standard).toContain("chat:message:create");
		expect(standard).not.toContain("payment:charge");
		expect(standard).not.toContain("payout:withdraw_funds");

		const admin = expandProfileToWhopScopes("admin", operations);
		expect(admin).toContain("payment:charge");
		expect(admin).toContain("payout:withdraw_funds");
	});

	it("requests the spec's scope names verbatim when grantable", () => {
		const scopes = expandProfileToWhopScopes("standard", [
			{
				profiles: ["standard"],
				scopes: ["access_pass:create"],
				method: "post",
				safety: { financial: false, credential: false },
			},
		]);
		expect(scopes).toContain("access_pass:create");
	});

	it("drops permissions with no grantable OAuth scope", () => {
		const scopes = expandProfileToWhopScopes("admin", [
			{
				profiles: ["admin"],
				scopes: ["some_future:permission"],
				method: "post",
				safety: { financial: false, credential: false },
			},
		]);
		expect(scopes).not.toContain("some_future:permission");
	});

	it("never hands a non-admin credential a financial-action scope", () => {
		for (const profile of ["read_only", "standard"]) {
			const scopes = expandProfileToWhopScopes(profile, operations);
			for (const denied of [
				"payment:charge",
				"payment:manage",
				"payout:withdraw_funds",
				"payout:transfer_funds",
				"payout:create_destination",
				"crypto_wallet:swap",
				"developer:manage_api_key",
			]) {
				expect(scopes, `${profile} must not hold ${denied}`).not.toContain(
					denied,
				);
			}
		}
	});

	it("keeps ordinary write scopes in standard", () => {
		const standard = expandProfileToWhopScopes("standard", operations);
		expect(standard).toContain("access_pass:create");
		expect(standard).toContain("plan:create");
	});

	it("recognizes exactly the three profiles", () => {
		for (const profile of PROFILE_NAMES) {
			expect(isProfileName(profile)).toBe(true);
		}
		expect(isProfileName("full_admin")).toBe(false);
		expect(isProfileName("")).toBe(false);
	});

	it("always includes the scope backing accounts_list (agents resolve business names with it)", () => {
		const accountsList = operations.find(
			(op) => op.toolName === "accounts_list",
		);
		expect(accountsList).toBeDefined();
		for (const profile of PROFILE_NAMES) {
			const scopes = expandProfileToWhopScopes(profile, operations);
			for (const scope of accountsList!.scopes) {
				expect(scopes, `${profile} must carry ${scope}`).toContain(scope);
			}
		}
	});
});
