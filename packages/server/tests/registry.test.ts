import { describe, expect, it } from "vitest";
import { buildRegistry, inferOperationName } from "../src/registry/generate.ts";
import { buildRealRegistry, loadMetadata, loadOpenApiRaw } from "./helpers.ts";

const registry = buildRealRegistry();

describe("registry generation", () => {
	it("covers every public operation: exposed, excluded, or pending review", () => {
		const doc = JSON.parse(loadOpenApiRaw());
		let total = 0;
		for (const item of Object.values(doc.paths) as Record<string, unknown>[]) {
			for (const method of ["get", "post", "put", "patch", "delete"]) {
				if (item[method]) total++;
			}
		}
		expect(
			registry.operations.length +
				registry.exclusions.length +
				registry.meta.pendingReview.length,
		).toBe(total);
		for (const exclusion of registry.exclusions) {
			expect(exclusion.reason.length).toBeGreaterThan(0);
			expect(exclusion.owner.length).toBeGreaterThan(0);
		}
	});

	it("has no writes awaiting classification (add a safety.yml rule to expose them)", () => {
		expect(registry.meta.pendingReview.map((entry) => entry.operation)).toEqual(
			[],
		);
	});

	it("is deterministic", () => {
		expect(JSON.stringify(buildRealRegistry())).toBe(JSON.stringify(registry));
	});

	it("excludes account security operations that require a first-party session", () => {
		const sessionOnlyOperations = [
			"GET /users/me/passkeys",
			"POST /users/me/passkeys",
			"POST /users/me/passkeys/challenge",
			"DELETE /users/me/passkeys/{id}",
			"GET /users/me/oauth_grants",
			"POST /users/me/oauth_grants",
		];
		const excluded = registry.exclusions.map((entry) => entry.operation);
		const exposed = registry.operations.map(
			(operation) => `${operation.method.toUpperCase()} ${operation.path}`,
		);

		for (const operation of sessionOnlyOperations) {
			expect(excluded).toContain(operation);
			expect(exposed).not.toContain(operation);
		}
	});

	it("preserves the stable public tool names from the existing CLI surface", () => {
		const names = new Set(registry.operations.map((op) => op.toolName));
		for (const expected of [
			"accounts_me",
			"accounts_list",
			"ad-campaigns_create",
			"ad-campaigns_pause",
			"payments_refund",
			"products_list",
			"swaps_quote",
			"transfers_create",
			"verifications_get",
			"users_me",
			"users_update-me",
		]) {
			expect(names, expected).toContain(expected);
		}
	});

	it("derives principals from the configured scope definitions", () => {
		const byName = new Map(registry.operations.map((op) => [op.toolName, op]));

		for (const toolName of [
			"bounties_cancel",
			"support-channels_create",
			"support-channels_get",
			"support-channels_list",
			"swaps_create",
			"transfers_create",
		]) {
			expect(byName.get(toolName)?.principals, toolName).toEqual([
				"user",
				"business",
				"app",
			]);
		}
		expect(byName.get("webhooks_create")?.principals).toEqual([
			"business",
			"app",
		]);
		// security: [] means public — every principal.
		expect(byName.get("swaps_quote")?.principals).toEqual([
			"user",
			"business",
			"app",
		]);

		// payout:withdraw_funds IS user-grantable — withdrawals must stay.
		expect(byName.get("withdrawals_create")?.principals).toContain("user");
		expect(byName.get("accounts_list")?.principals).toEqual([
			"user",
			"business",
			"app",
		]);
	});

	it("mirrors every operation's OpenAPI security blocks into scopeAlternatives", () => {
		const doc = JSON.parse(loadOpenApiRaw());
		for (const op of registry.operations) {
			const security = (doc.paths[op.path]?.[op.method]?.security ?? []) as {
				bearerAuth?: string[];
			}[];
			const alternatives =
				security.length > 0
					? security.map((alternative) =>
							[...(alternative.bearerAuth ?? [])].sort(),
						)
					: [[]];
			const key = `${op.method} ${op.path}`;
			expect(op.scopeAlternatives, key).toEqual(alternatives);
			expect(op.scopes, key).toEqual([...new Set(alternatives.flat())].sort());
		}
	});

	it("keeps AND-scopes within one alternative distinct from OR-alternatives", () => {
		const byName = new Map(registry.operations.map((op) => [op.toolName, op]));
		// The exact scope matrix is pinned once, in the backend's
		// open_api_schema_spec.rb; this exemplar only guards the shape.
		expect(byName.get("messages_delete")?.scopeAlternatives).toEqual([
			["chat:message:create", "chat:read"],
			["dms:message:manage", "dms:read"],
			["livestream:chat:read", "livestream:chat:write"],
			["support_chat:message:create", "support_chat:read"],
		]);
		expect(byName.get("dm-channels_update")?.scopeAlternatives).toEqual([
			["dms:channel:manage"],
			["support_chat:create"],
		]);
	});

	it("excludes operations no MCP principal can call", () => {
		// developer:manage_api_key is user: false and disallows both API-key
		// authorizations — only interactive dashboard sessions qualify.
		const names = new Set(registry.operations.map((op) => op.toolName));
		for (const dead of [
			"api-keys_create",
			"api-keys_delete",
			"api-keys_get",
			"api-keys_list",
			"api-keys_rotate",
			"api-keys_update",
		]) {
			expect(names, dead).not.toContain(dead);
		}
		const generated = registry.exclusions.filter(
			(entry) => entry.owner === "registry-generator",
		);
		expect(generated.length).toBeGreaterThanOrEqual(6);
		for (const entry of generated) {
			expect(entry.reason).toContain("configured scope definitions");
		}
	});

	it("fails on scopes missing from the scope definitions", () => {
		const doc = JSON.parse(loadOpenApiRaw());
		const metadata = loadMetadata();
		expect(() =>
			buildRegistry(
				doc,
				{ ...metadata, scopeDefinitions: {} },
				{
					openapiSha256: "test",
				},
			),
		).toThrow(/No scope definition/);
	});

	it("tags the native surface and keeps it non-empty", () => {
		expect(registry.meta.nativeOperationCount).toBeGreaterThan(100);
		expect(
			registry.operations.filter((op) => op.surface === "legacy").length,
		).toBeGreaterThan(0);
		for (const op of registry.operations) {
			expect(["native", "legacy"], op.toolName).toContain(op.surface);
		}
	});

	it("flags known money-movement operations as financial + confirmed", () => {
		const byKey = new Map(
			registry.operations.map((op) => [
				`${op.method.toUpperCase()} ${op.path}`,
				op,
			]),
		);
		for (const key of [
			"POST /payments",
			"POST /payments/{id}/refund",
			"POST /payouts",
			"POST /withdrawals",
			"POST /transfers",
			"POST /bounties/{id}/cancel",
			"POST /wallets/send",
		]) {
			const op = byKey.get(key);
			if (!op) continue;
			expect(op.safety.financial, key).toBe(true);
			expect(op.safety.confirmationRequired, key).toBe(true);
		}
		expect(
			registry.operations.filter((op) => op.safety.financial).length,
		).toBeGreaterThan(10);
	});

	it("treats setup intent creation as confirmed financial configuration", () => {
		const operation = registry.operations.find(
			(op) => op.method === "post" && op.path === "/setup_intents",
		);
		expect(operation).toBeDefined();
		expect(operation?.safety).toMatchObject({
			classification: "mutating",
			financial: true,
			externalPublication: true,
			idempotency: "none",
			confirmationRequired: true,
		});
		expect(operation?.surface).toBe("legacy");
		expect(operation?.annotations).toMatchObject({
			destructiveHint: true,
			idempotentHint: false,
			openWorldHint: true,
		});
		expect(operation?.profiles).toEqual(["admin"]);
	});

	it("pins the API version from the contract", () => {
		expect(registry.meta.apiVersionDate).toMatch(/^\d{4}-\d{2}-\d{2}/);
	});

	it("emits strict input schemas", () => {
		for (const op of registry.operations) {
			expect(op.inputSchema.additionalProperties, op.toolName).toBe(false);
			expect(op.inputSchema.type).toBe("object");
		}
	});

	it("never exposes authorization or version headers as inputs", () => {
		for (const op of registry.operations) {
			const properties = Object.keys(op.inputSchema.properties ?? {});
			expect(properties).not.toContain("Authorization");
			expect(properties).not.toContain("Api-Version-Date");
		}
	});

	it("reserves mcp_confirmation_token for runtime approval", () => {
		for (const op of registry.operations) {
			expect(op.inputSchema.properties, op.toolName).not.toHaveProperty(
				"mcp_confirmation_token",
			);
		}
	});

	it("never requires the account parameter (the runtime injects it)", () => {
		for (const op of registry.operations) {
			if (!op.accountParam) continue;
			expect(op.inputSchema.required, op.toolName).not.toContain(
				op.accountParam,
			);
		}
	});

	it("annotates GETs read-only and deletes destructive", () => {
		for (const op of registry.operations) {
			if (op.method === "get") {
				expect(op.annotations.readOnlyHint, op.toolName).toBe(true);
			}
			// Removing an emoji reaction is the one delete reviewed as non-destructive.
			if (op.method === "delete" && op.toolName !== "reactions_delete") {
				expect(op.safety.classification, op.toolName).toBe("destructive");
			}
		}
	});

	it("marks every confirmation-gated operation destructive for host approval UIs", () => {
		for (const op of registry.operations) {
			if (
				op.safety.confirmationRequired ||
				op.safety.financial ||
				op.safety.credential
			) {
				expect(op.annotations.destructiveHint, op.toolName).toBe(true);
			}
		}
	});

	it("gates every financial and credential mutation behind confirmation", () => {
		for (const op of registry.operations) {
			if (op.method === "get") continue;
			if (op.safety.financial || op.safety.credential) {
				expect(op.safety.confirmationRequired, op.toolName).toBe(true);
			}
		}
	});

	it("keeps financial and credential operations out of read_only and standard", () => {
		for (const op of registry.operations) {
			if (op.safety.credential || op.safety.financial) {
				expect(op.profiles, op.toolName).toEqual(["admin"]);
			}
		}
	});

	it("restricts the read_only profile to read-only operations", () => {
		for (const op of registry.operations) {
			if (op.profiles.includes("read_only")) {
				expect(op.safety.classification, op.toolName).toBe("read_only");
			}
		}
	});

	it("includes every operation in the admin profile", () => {
		for (const op of registry.operations) {
			expect(op.profiles, op.toolName).toContain("admin");
		}
	});

	it("fails on duplicate tool names", () => {
		const doc = JSON.parse(loadOpenApiRaw());
		doc.paths["/accounts/duplicate_me"] = {
			get: {
				operationId: "dupOne",
				tags: ["Accounts"],
				security: [{ bearerAuth: [] }],
			},
		};
		doc.paths["/accounts/duplicate_me/{id}"] = {
			get: {
				operationId: "dupTwo",
				tags: ["Accounts"],
				security: [{ bearerAuth: [] }],
			},
		};
		expect(() =>
			buildRegistry(doc, loadMetadata(), { openapiSha256: "x" }),
		).toThrow(/Duplicate tool name/);
	});

	it("fails on a missing operationId", () => {
		const doc = JSON.parse(loadOpenApiRaw());
		delete doc.paths["/accounts"].get.operationId;
		expect(() =>
			buildRegistry(doc, loadMetadata(), { openapiSha256: "x" }),
		).toThrow(/Missing operationId/);
	});

	it("fails when an exclusion no longer matches the contract", () => {
		const metadata = loadMetadata();
		metadata.exclusions.exclusions.push({
			operation: "GET /does_not_exist",
			reason: "test",
			owner: "test",
		});
		expect(() =>
			buildRegistry(JSON.parse(loadOpenApiRaw()), metadata, {
				openapiSha256: "x",
			}),
		).toThrow(/matches no operation/);
	});

	it("fails when a safety rule references a removed operation", () => {
		const metadata = loadMetadata();
		metadata.safety.rules.push({
			name: "stale-rule",
			match: { operations: ["POST /does_not_exist"] },
			set: { classification: "mutating" },
		});
		expect(() =>
			buildRegistry(JSON.parse(loadOpenApiRaw()), metadata, {
				openapiSha256: "x",
			}),
		).toThrow(/unknown operation/);
	});

	it("drops an unclassified write into pendingReview instead of exposing it", () => {
		const doc = JSON.parse(loadOpenApiRaw());
		doc.paths["/accounts/new_unreviewed_thing"] = {
			post: {
				operationId: "newUnreviewedThing",
				tags: ["Some Future Tag"],
				security: [{ bearerAuth: [] }],
			},
		};
		const built = buildRegistry(doc, loadMetadata(), { openapiSha256: "x" });
		expect(
			built.operations.find(
				(o) => o.toolName === "some-future-tag_new_unreviewed_thing",
			),
		).toBeUndefined();
		expect(built.meta.pendingReview).toContainEqual({
			operation: "POST /accounts/new_unreviewed_thing",
			openapiOperationId: "newUnreviewedThing",
			tag: "Some Future Tag",
			surface: "legacy",
		});
	});

	it("derives ID prefixes from path parameter examples", () => {
		const withPrefixes = registry.operations.filter((op) => op.idPrefixes);
		expect(withPrefixes.length).toBeGreaterThan(0);
	});
});

describe("inferOperationName", () => {
	it("matches the CLI naming algorithm", () => {
		expect(inferOperationName("GET", "/accounts")).toBe("list");
		expect(inferOperationName("POST", "/accounts")).toBe("create");
		expect(inferOperationName("GET", "/accounts/{id}")).toBe("get");
		expect(inferOperationName("PATCH", "/accounts/{id}")).toBe("update");
		expect(inferOperationName("GET", "/accounts/me")).toBe("me");
		expect(inferOperationName("POST", "/swaps/quote")).toBe("quote");
		expect(inferOperationName("GET", "/swaps")).toBe("status");
		expect(inferOperationName("PATCH", "/users/me")).toBe("update-me");
		expect(inferOperationName("GET", "/users/{id}/access/{resource_id}")).toBe(
			"access",
		);
	});
});
