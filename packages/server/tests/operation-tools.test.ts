import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import type { SurfaceName } from "../src/policy/surfaces.ts";
import type { PrincipalContext } from "../src/policy/types.ts";
import { InMemoryAuditSink } from "../src/safety/audit.ts";
import { expandQuery } from "../src/runtime/operation-tools.ts";
import { createWhopMcpServer } from "../src/runtime/server.ts";
import {
	buildRealRegistry,
	fakeFetch,
	principalFixture,
	staticCredential,
} from "./helpers.ts";

const registry = buildRealRegistry();
const INTENT = {
	intent: "Help me run my store",
	intent_id: "123e4567-e89b-42d3-a456-426614174000",
};

async function connect(
	options: {
		principal?: PrincipalContext;
		surface?: SurfaceName;
		fetch?: typeof fetch;
		auditSink?: InMemoryAuditSink;
	} = {},
) {
	const { server } = createWhopMcpServer({
		registry,
		toolListing: "compact",
		surface: options.surface,
		credentialAdapter: staticCredential(),
		principal: options.principal ?? principalFixture(),
		fetch: options.fetch ?? fakeFetch().fetch,
		auditSink: options.auditSink,
		baseUrl: "https://api.whop.test/api/v1",
	});
	const client = new Client({ name: "test-client", version: "1.0.0" });
	const [clientTransport, serverTransport] =
		InMemoryTransport.createLinkedPair();
	await Promise.all([
		server.connect(serverTransport),
		client.connect(clientTransport),
	]);
	return client;
}

function text(result: unknown): string {
	return (result as { content: { text: string }[] }).content[0]?.text ?? "";
}

async function searchNames(client: Client, query: string): Promise<string[]> {
	const result = await client.callTool({
		name: "search_operations",
		arguments: { query },
	});
	expect(result.isError).toBeFalsy();
	const body = JSON.parse(text(result)) as {
		operations: { name: string }[];
	};
	return body.operations.map((operation) => operation.name);
}

describe("search_operations", () => {
	const cases: [string, string][] = [
		["refund a customer", "payments_refund"],
		["find clipping bounties", "bounties_list"],
		["cancel a membership", "memberships_cancel"],
		["create a promo code", "promo-codes_create"],
		["list webhooks", "webhooks_list"],
		["list my payouts", "payouts_list"],
		["add a price to a product", "variants_create"],
		["create an invoice", "invoices_create"],
		["pause an ad", "ads_pause"],
		["who are my affiliates", "affiliates_list"],
		["upload an image", "files_create"],
	];
	for (const [query, expected] of cases) {
		it(`ranks ${expected} in the top 3 for "${query}"`, async () => {
			const client = await connect();
			const names = await searchNames(client, query);
			expect(names.slice(0, 3)).toContain(expected);
		});
	}

	it("returns input schemas for the top 3 matches only", async () => {
		const client = await connect();
		const result = await client.callTool({
			name: "search_operations",
			arguments: { query: "promo code", limit: 5 },
		});
		const body = JSON.parse(text(result)) as {
			operations: { input_schema?: unknown; call_with: string }[];
		};
		expect(body.operations).toHaveLength(5);
		expect(body.operations.slice(0, 3).every((op) => op.input_schema)).toBe(
			true,
		);
		expect(body.operations.slice(3).some((op) => op.input_schema)).toBe(false);
	});

	it("answers an unmatched query with an empty result, not an error", async () => {
		const client = await connect();
		const result = await client.callTool({
			name: "search_operations",
			arguments: { query: "zzqqxx" },
		});
		expect(result.isError).toBeFalsy();
		expect(JSON.parse(text(result)).operations).toEqual([]);
	});

	it("expands synonyms into the stemmed tokens the index holds", () => {
		const [trend] = expandQuery("trend");
		const [[series]] = expandQuery("series");
		expect(trend).toContain(series);
		expect(expandQuery("sales")).toEqual([["sale", "payment"]]);
		expect(expandQuery("this")).toEqual([]);
	});

	it("marks account_id required in returned schemas when no business is bound", async () => {
		const client = await connect({
			principal: principalFixture({ principalType: "user", accountId: null }),
		});
		const result = await client.callTool({
			name: "search_operations",
			arguments: { query: "create a promo code" },
		});
		const body = JSON.parse(text(result)) as {
			operations: { name: string; input_schema?: { required?: string[] } }[];
		};
		const promoCodes = body.operations.find(
			(operation) => operation.name === "promo-codes_create",
		);
		expect(promoCodes?.input_schema?.required).toContain("account_id");
	});

	it("never returns operations the connection cannot see", async () => {
		const client = await connect({ surface: "claude_directory" });
		const names = await searchNames(client, "create a transfer");
		expect(names).not.toContain("transfers_create");
		const readOnly = await connect({
			principal: principalFixture({ permissionProfile: "read_only" }),
		});
		expect(await searchNames(readOnly, "create a promo code")).not.toContain(
			"promo-codes_create",
		);
	});
});

describe("search guidance", () => {
	it("tells the agent the listing is partial and to search before giving up", async () => {
		const client = await connect();
		const search = (await client.listTools()).tools.find(
			(tool) => tool.name === "search_operations",
		);
		expect(search?.description).toContain("cover only the most common tasks");
		expect(search?.description).toContain("before telling the user");
		expect(search?.description).toMatch(/\(\d{3} in total\)/);
		expect(client.getInstructions()).toContain("Before telling the user");
	});
});

describe("describe_operation", () => {
	it("returns the full input schema, including fields listings omit", async () => {
		const client = await connect();
		const result = await client.callTool({
			name: "describe_operation",
			arguments: { name: "stats_time-series_get" },
		});
		const body = JSON.parse(text(result)) as {
			input_schema: { properties: Record<string, { type?: unknown }> };
		};
		expect(body.input_schema.properties.steps?.type).toBeDefined();
	});

	it("marks account_id required when no business is bound, like the listing", async () => {
		async function required(principal: PrincipalContext) {
			const client = await connect({ principal });
			const result = await client.callTool({
				name: "describe_operation",
				arguments: { name: "promo-codes_create" },
			});
			const body = JSON.parse(text(result)) as {
				input_schema: { required?: string[] };
			};
			return body.input_schema.required ?? [];
		}
		expect(
			await required(
				principalFixture({ principalType: "user", accountId: null }),
			),
		).toContain("account_id");
		expect(await required(principalFixture())).not.toContain("account_id");
	});

	it("refuses an operation the connection cannot see", async () => {
		const client = await connect({ surface: "claude_directory" });
		const result = await client.callTool({
			name: "describe_operation",
			arguments: { name: "transfers_create" },
		});
		expect(result.isError).toBe(true);
		expect(text(result)).toContain("tool_not_found");
	});
});

describe("call_read_operation and call_write_operation", () => {
	it("runs a read operation and audits it under its own name", async () => {
		const { fetch, requests } = fakeFetch();
		const auditSink = new InMemoryAuditSink();
		const client = await connect({ fetch, auditSink });
		const result = await client.callTool({
			name: "call_read_operation",
			arguments: { ...INTENT, name: "payouts_list", arguments: {} },
		});
		expect(result.isError).toBeFalsy();
		expect(requests[0]?.url).toContain("/payouts");
		expect(auditSink.events.at(-1)).toMatchObject({
			toolName: "payouts_list",
			outcome: "executed",
			via: "call_read_operation",
		});
	});

	it("runs a write operation and forwards its idempotency key", async () => {
		const { fetch, requests } = fakeFetch();
		const client = await connect({ fetch });
		const result = await client.callTool({
			name: "call_write_operation",
			arguments: {
				...INTENT,
				name: "promo-codes_create",
				idempotency_key: "retry-key-1",
				arguments: {
					code: "SAVE10",
					amount_off: 10,
					promo_type: "percentage",
					base_currency: "usd",
					new_users_only: false,
					promo_duration_months: 1,
				},
			},
		});
		expect(result.isError).toBeFalsy();
		expect(requests).toHaveLength(1);
		expect(requests[0]?.method).toBe("POST");
		expect(requests[0]?.url).toContain("/promo_codes");
		expect(requests[0]?.headers["idempotency-key"]).toBe("retry-key-1");
		expect(requests[0]?.body).toMatchObject({ code: "SAVE10" });
	});

	it("refuses a write through call_read_operation, naming the right tool", async () => {
		const client = await connect();
		const result = await client.callTool({
			name: "call_read_operation",
			arguments: { ...INTENT, name: "promo-codes_create", arguments: {} },
		});
		expect(result.isError).toBe(true);
		expect(text(result)).toContain("call_write_operation");
	});

	it("refuses a read through call_write_operation, naming the right tool", async () => {
		const client = await connect();
		const result = await client.callTool({
			name: "call_write_operation",
			arguments: { ...INTENT, name: "payouts_list" },
		});
		expect(result.isError).toBe(true);
		expect(text(result)).toContain("call_read_operation");
	});

	it("requires intent attribution", async () => {
		const client = await connect();
		const result = await client.callTool({
			name: "call_read_operation",
			arguments: { name: "payouts_list" },
		});
		expect(result.isError).toBe(true);
		expect(text(result)).toContain("invalid_input");
	});

	it("refuses operations hidden from the connection's surface", async () => {
		const { fetch, requests } = fakeFetch();
		const client = await connect({ surface: "claude_directory", fetch });
		const result = await client.callTool({
			name: "call_write_operation",
			arguments: { ...INTENT, name: "transfers_create", arguments: {} },
		});
		expect(result.isError).toBe(true);
		expect(text(result)).toContain("tool_not_found");
		expect(requests).toHaveLength(0);
	});

	it("audits a failed call with the operation name and via", async () => {
		const auditSink = new InMemoryAuditSink();
		const client = await connect({
			auditSink,
			fetch: fakeFetch(() => ({ status: 500, body: { error: "boom" } })).fetch,
		});
		await client.callTool({
			name: "call_read_operation",
			arguments: { ...INTENT, name: "payouts_list" },
		});
		expect(auditSink.events.at(-1)).toMatchObject({
			toolName: "payouts_list",
			outcome: "failed",
			via: "call_read_operation",
		});
	});
});
