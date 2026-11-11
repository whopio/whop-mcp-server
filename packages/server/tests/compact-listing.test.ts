import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { PROFILE_NAMES } from "../src/policy/profiles.ts";
import {
	movesMoney,
	SURFACE_NAMES,
	type SurfaceName,
} from "../src/policy/surfaces.ts";
import { visibleOperations } from "../src/policy/visibility.ts";
import type { PrincipalContext } from "../src/policy/types.ts";
import {
	createWhopMcpServer,
	type ToolListing,
} from "../src/runtime/server.ts";
import {
	buildRealRegistry,
	fakeFetch,
	principalFixture,
	staticCredential,
} from "./helpers.ts";

const registry = buildRealRegistry();
const TOOL_LIST_BUDGET_BYTES = 175_000;
const MUSE_TOOL_LIST_BUDGET_BYTES = 150_000;
const MAX_LISTED_OPERATIONS = 45;
const OPERATION_TOOLS = [
	"search_operations",
	"describe_operation",
	"call_read_operation",
	"call_write_operation",
];
const INTENT = {
	intent: "Show me this month's stats",
	intent_id: "123e4567-e89b-42d3-a456-426614174000",
};

async function connect(
	options: {
		toolListing?: ToolListing;
		principal?: PrincipalContext;
		surface?: SurfaceName;
		fetch?: typeof fetch;
	} = {},
) {
	const { server } = createWhopMcpServer({
		registry,
		toolListing: options.toolListing ?? "compact",
		surface: options.surface,
		credentialAdapter: staticCredential(),
		principal: options.principal ?? principalFixture(),
		fetch: options.fetch ?? fakeFetch().fetch,
		docs: true,
		chatGptCompat: true,
		feedbackSink: { record: async () => "fb_test" },
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

describe("compact tool listing", () => {
	for (const profile of PROFILE_NAMES) {
		for (const surface of SURFACE_NAMES) {
			for (const principalType of ["user", "business"] as const) {
				it(`stays under the size budget for ${principalType} ${profile} on ${surface}`, async () => {
					const client = await connect({
						surface,
						principal: principalFixture({
							principalType,
							permissionProfile: profile,
							accountId: principalType === "user" ? null : "biz_boundAccount",
						}),
					});
					const result = await client.listTools();
					const bytes = new TextEncoder().encode(JSON.stringify(result)).length;
					expect(bytes).toBeLessThanOrEqual(
						surface === "muse"
							? MUSE_TOOL_LIST_BUDGET_BYTES
							: TOOL_LIST_BUDGET_BYTES,
					);
					const listedOperations = result.tools.filter((tool) =>
						registry.operations.some((op) => op.toolName === tool.name),
					);
					expect(listedOperations.length).toBeLessThanOrEqual(
						MAX_LISTED_OPERATIONS,
					);
				});
			}
		}
	}

	it("lists only core operations plus the operation tools", async () => {
		const client = await connect();
		const names = (await client.listTools()).tools.map((tool) => tool.name);
		const core = registry.operations
			.filter((op) => op.core)
			.map((op) => op.toolName);
		expect(core.length).toBeGreaterThan(0);
		for (const name of [...core, ...OPERATION_TOOLS]) {
			expect(names).toContain(name);
		}
		expect(names).not.toContain("payouts_list");
		expect(names).not.toContain("plans_create");
	});

	it("lists core operations most used first", async () => {
		const client = await connect();
		const names = (await client.listTools()).tools.map((tool) => tool.name);
		const listedCore = names.filter((name) =>
			registry.operations.some((op) => op.toolName === name && op.core),
		);
		const byRank = registry.operations
			.filter((op) => op.core)
			.sort((a, b) => (a.core ?? 0) - (b.core ?? 0))
			.map((op) => op.toolName);
		expect(listedCore).toEqual(byRank);
		expect(listedCore.slice(0, 3)).toEqual([
			"payments_list",
			"memberships_list",
			"messages_list",
		]);
	});

	it("lists every operation and no operation tools in full mode", async () => {
		const client = await connect({ toolListing: "full" });
		const names = (await client.listTools()).tools.map((tool) => tool.name);
		expect(names).toContain("payouts_list");
		for (const name of OPERATION_TOOLS) expect(names).not.toContain(name);
	});

	it("still runs an unlisted operation called by its own name", async () => {
		const { fetch, requests } = fakeFetch();
		const client = await connect({ fetch });
		const result = await client.callTool({
			name: "payouts_list",
			arguments: INTENT,
		});
		expect(result.isError).toBeFalsy();
		expect(requests[0]?.url).toContain("/payouts");
	});

	it("leaves hidden inputs out of the listing but still accepts and validates them", async () => {
		const { fetch, requests } = fakeFetch();
		const client = await connect({ fetch });
		const tools = (await client.listTools()).tools;
		const stats = tools.find((entry) => entry.name === "stats_time-series_get");
		expect(stats?.inputSchema.properties).toHaveProperty("interval");
		expect(stats?.inputSchema.properties).toHaveProperty("metric");
		expect(stats?.inputSchema.properties).not.toHaveProperty("steps");
		expect(stats?.inputSchema.additionalProperties).toBe(true);
		expect(stats?.description).toContain("describe_operation");
		const payments = tools.find((entry) => entry.name === "payments_list");
		expect(payments?.inputSchema.properties).not.toHaveProperty(
			"payment_methods",
		);
		expect(payments?.inputSchema.properties).toHaveProperty("statuses");

		const range = {
			...INTENT,
			metric: "revenue",
			from: "2026-10-01T00:00:00Z",
			to: "2026-11-01T00:00:00Z",
		};
		const invalid = await client.callTool({
			name: "stats_time-series_get",
			arguments: { ...range, steps: "not-an-object" },
		});
		expect(invalid.isError).toBe(true);
		expect(JSON.stringify(invalid.content)).toContain("invalid_input");

		const hidden = await client.callTool({
			name: "stats_time-series_get",
			arguments: { ...range, device_type: "mobile" },
		});
		expect(hidden.isError).toBeFalsy();
		expect(requests.at(-1)?.url).toContain("device_type=mobile");

		const undeclared = await client.callTool({
			name: "stats_time-series_get",
			arguments: { ...range, not_a_field: true },
		});
		expect(undeclared.isError).toBe(true);
	});

	it("requires account_id on account tools when no business is bound", async () => {
		const unbound = await connect({
			principal: principalFixture({ principalType: "user", accountId: null }),
		});
		const listed = (await unbound.listTools()).tools.find(
			(tool) => tool.name === "promo-codes_create",
		);
		expect(listed?.inputSchema.required).toContain("account_id");

		const bound = await connect();
		const boundListed = (await bound.listTools()).tools.find(
			(tool) => tool.name === "promo-codes_create",
		);
		expect(boundListed?.inputSchema.required).not.toContain("account_id");
	});

	it("keeps full listings unchanged by listed-schema overrides", async () => {
		const client = await connect({ toolListing: "full" });
		const tool = (await client.listTools()).tools.find(
			(entry) => entry.name === "stats_time-series_get",
		);
		expect(tool?.inputSchema.properties).toHaveProperty("steps");
		expect(tool?.inputSchema.additionalProperties).toBe(false);
	});
});

describe("muse surface", () => {
	const userPrincipal = principalFixture({
		principalType: "user",
		accountId: null,
	});
	const operationNames = new Set(registry.operations.map((op) => op.toolName));

	async function listed(surface?: SurfaceName) {
		const client = await connect({ surface, principal: userPrincipal });
		return (await client.listTools()).tools;
	}

	it("lists /mcp's core tools without the ones that move money", async () => {
		const coreOnMcp = (await listed())
			.map((tool) => tool.name)
			.filter((name) => operationNames.has(name));
		const onMuse = (await listed("muse"))
			.map((tool) => tool.name)
			.filter((name) => operationNames.has(name));
		const moneyTools = new Set(
			registry.operations.filter(movesMoney).map((op) => op.toolName),
		);
		expect(onMuse).toEqual(coreOnMcp.filter((name) => !moneyTools.has(name)));
		expect(coreOnMcp).toContain("payments_refund");
		expect(onMuse).not.toContain("payments_refund");
	});

	it("offers read-only operation tools and no intent fields", async () => {
		const tools = await listed("muse");
		const names = tools.map((tool) => tool.name);
		for (const name of [
			"search_operations",
			"describe_operation",
			"call_read_operation",
		]) {
			expect(names).toContain(name);
		}
		expect(names).not.toContain("call_write_operation");
		expect(JSON.stringify(tools)).not.toContain("intent_id");
		const search = tools.find((tool) => tool.name === "search_operations");
		expect(search?.description).toContain("every other Whop read");
		expect(search?.description).toContain("before telling the user");
		expect(search?.description).not.toContain("call_write_operation");
	});

	it("reaches every read but only the listed writes, and none that move money", async () => {
		const reachable = visibleOperations(registry, userPrincipal, {
			surface: "muse",
		});
		const writes = reachable.filter((op) => !op.annotations.readOnlyHint);
		expect(writes.every((op) => op.core !== undefined)).toBe(true);
		expect(reachable.filter(movesMoney)).toEqual([]);
		expect(reachable.map((op) => op.toolName)).toContain("payouts_list");
		expect(reachable.map((op) => op.toolName)).not.toContain("webhooks_list");

		const { fetch, requests } = fakeFetch();
		const client = await connect({
			surface: "muse",
			principal: userPrincipal,
			fetch,
		});
		const read = await client.callTool({
			name: "call_read_operation",
			arguments: { name: "payouts_list" },
		});
		expect(read.isError).toBeFalsy();
		expect(requests).toHaveLength(1);

		for (const name of [
			"transfers_create",
			"payments_refund",
			"webhooks_create",
		]) {
			const direct = await client.callTool({ name, arguments: {} });
			expect(JSON.stringify(direct.content)).toContain("tool_not_found");
			const viaRead = await client.callTool({
				name: "call_read_operation",
				arguments: { name },
			});
			expect(viaRead.isError).toBe(true);
		}
		const search = await client.callTool({
			name: "search_operations",
			arguments: { query: "create a webhook" },
		});
		expect(JSON.stringify(search.content)).not.toContain("webhooks_create");
		expect(requests).toHaveLength(1);
	});

	it("runs a listed tool without intent fields and sends no intent", async () => {
		const { fetch, requests } = fakeFetch();
		const client = await connect({
			surface: "muse",
			principal: userPrincipal,
			fetch,
		});
		const result = await client.callTool({
			name: "products_list",
			arguments: { account_id: "biz_1" },
		});
		expect(result.isError).toBeFalsy();
		expect(requests).toHaveLength(1);
		expect(requests[0]?.headers["x-whop-mcp-context"]).toBeUndefined();
		expect(client.getInstructions()).not.toContain("intent_id");
	});
});
