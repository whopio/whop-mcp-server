import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { SURFACE_NAMES, type SurfaceName } from "../src/policy/surfaces.ts";
import { buildRegistry, inferVerbName } from "../src/registry/generate.ts";
import type { RegistryManifest } from "../src/registry/types.ts";
import { InMemoryAuditSink } from "../src/safety/audit.ts";
import {
	createWhopMcpServer,
	type ToolListing,
} from "../src/runtime/server.ts";
import {
	buildRealRegistry,
	fakeFetch,
	loadMetadata,
	loadOpenApiRaw,
	principalFixture,
	staticCredential,
} from "./helpers.ts";

const registry = buildRealRegistry();
const VERB_SURFACES = SURFACE_NAMES.filter((surface) => surface !== "muse");
const INTENT = {
	intent: "Show me my sales",
	intent_id: "123e4567-e89b-42d3-a456-426614174000",
};
const renamed = registry.operations.filter((op) => op.verbName !== op.toolName);
const registryOnly = new Set(renamed.map((op) => op.toolName));

async function connect(
	options: {
		registry?: RegistryManifest;
		surface?: SurfaceName;
		toolListing?: ToolListing;
		fetch?: typeof fetch;
		auditSink?: InMemoryAuditSink;
	} = {},
) {
	const { server } = createWhopMcpServer({
		registry: options.registry ?? registry,
		surface: options.surface,
		toolListing: options.toolListing ?? "compact",
		credentialAdapter: staticCredential(),
		principal: principalFixture({ principalType: "user", accountId: null }),
		fetch: options.fetch ?? fakeFetch().fetch,
		auditSink: options.auditSink,
		docs: true,
		chatGptCompat: true,
		feedback: true,
		promptsAndResources: true,
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

function registryNamesIn(text: string): string[] {
	return [...registryOnly].filter((name) =>
		new RegExp(`(?<![\\w-])${name.replace(/-/g, "\\-")}(?![\\w-])`).test(text),
	);
}

function text(result: unknown): string {
	return (result as { content: { text: string }[] }).content[0]?.text ?? "";
}

describe("verb names", () => {
	it.each([
		["listPayments", "list_payments"],
		["retrieveAdCampaign", "get_ad_campaign"],
		["listCourse", "list_courses"],
		["listCompanyTokenTransaction", "list_company_token_transactions"],
		["listFinancialActivity", "list_financial_activity"],
		["pauseAd", "pause_ad"],
	])("names %s %s", (operationId, name) => {
		expect(inferVerbName(operationId)).toBe(name);
	});

	it("gives every operation its own snake_case name, apart from every registry name", () => {
		const owners = new Map<string, string>();
		for (const op of registry.operations) {
			expect(op.verbName, op.toolName).toMatch(/^[a-z]+(_[a-z0-9]+)+$/);
			owners.set(op.toolName, op.toolName);
		}
		for (const op of registry.operations) {
			const owner = owners.get(op.verbName);
			expect(owner === undefined || owner === op.toolName, op.verbName).toBe(
				true,
			);
			owners.set(op.verbName, op.toolName);
		}
	});

	it("takes the override name where operation-overrides.yml sets one", () => {
		const named = (key: string) =>
			registry.operations.find(
				(op) => `${op.method.toUpperCase()} ${op.path}` === key,
			)?.verbName;
		expect(named("POST /products/{id}/publish")).toBe(
			"submit_app_product_for_review",
		);
		expect(named("GET /search")).toBe("search_account_records");
		expect(named("GET /payout_methods")).toBe("list_account_payout_methods");
		expect(named("GET /payouts/methods")).toBe("list_payout_methods");
	});

	it("fails the build when a verb name is another operation's registry name", () => {
		const metadata = loadMetadata();
		metadata.overrides.overrides = {
			...metadata.overrides.overrides,
			"GET /products": { verbName: "payments_list" },
		};
		expect(() =>
			buildRegistry(JSON.parse(loadOpenApiRaw()), metadata, {
				openapiSha256: "test",
			}),
		).toThrow(/payments_list.*already used by GET \/payments/);
	});

	it("keeps every operation name apart from the built-in tool names", async () => {
		const client = await connect({ registry: { ...registry, operations: [] } });
		const builtins = (await client.listTools()).tools.map((tool) => tool.name);
		expect(builtins).toContain("search_operations");
		expect(builtins).toContain("fetch");
		const names = new Set(
			registry.operations.flatMap((op) => [op.toolName, op.verbName]),
		);
		expect(builtins.filter((name) => names.has(name))).toEqual([]);
	});
});

describe("listed names", () => {
	for (const surface of VERB_SURFACES) {
		it(`lists verb names on ${surface} and mentions no registry name`, async () => {
			const client = await connect({ surface });
			const { tools } = await client.listTools();
			const operations = tools.filter((tool) =>
				registry.operations.some(
					(op) => op.verbName === tool.name || op.toolName === tool.name,
				),
			);
			expect(operations.length).toBeGreaterThan(0);
			for (const tool of operations) {
				expect(registryOnly.has(tool.name), tool.name).toBe(false);
			}
			expect(registryNamesIn(JSON.stringify(tools))).toEqual([]);
			expect(registryNamesIn(client.getInstructions() ?? "")).toEqual([]);
		});
	}

	it("lists registry names on muse, whose tools were approved under them", async () => {
		const client = await connect({ surface: "muse" });
		const { tools } = await client.listTools();
		const names = tools.map((tool) => tool.name);
		expect(names).toContain("payments_list");
		expect(names).not.toContain("list_payments");
		expect(registryNamesIn(JSON.stringify(tools)).length).toBeGreaterThan(10);
	});

	it("names tools in guides as the route lists them", async () => {
		const client = await connect();
		const { resources } = await client.listResources();
		expect(resources.length).toBeGreaterThan(0);
		expect(registryNamesIn(JSON.stringify(resources))).toEqual([]);
		for (const resource of resources) {
			const { contents } = await client.readResource({ uri: resource.uri });
			expect(registryNamesIn(JSON.stringify(contents)), resource.uri).toEqual(
				[],
			);
		}
		const { prompts } = await client.listPrompts();
		expect(registryNamesIn(JSON.stringify(prompts))).toEqual([]);
		for (const prompt of prompts) {
			const result = await client.getPrompt({
				name: prompt.name,
				arguments: Object.fromEntries(
					(prompt.arguments ?? []).map((argument) => [argument.name, "1"]),
				),
			});
			expect(registryNamesIn(JSON.stringify(result)), prompt.name).toEqual([]);
		}
	});

	it("lists every operation under its verb name in full mode", async () => {
		const client = await connect({ toolListing: "full" });
		const { tools } = await client.listTools();
		const names = new Set(tools.map((tool) => tool.name));
		expect(names).toContain("list_payouts");
		expect(names).not.toContain("payouts_list");
		expect(registryNamesIn(JSON.stringify(tools))).toEqual([]);
	});
});

describe("calling by either name", () => {
	it("runs an operation called by its registry name or its verb name", async () => {
		const { fetch, requests } = fakeFetch();
		const client = await connect({ fetch });
		for (const name of ["payments_list", "list_payments"]) {
			const result = await client.callTool({
				name,
				arguments: { ...INTENT, account_id: "biz_1" },
			});
			expect(result.isError, name).toBeFalsy();
		}
		expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
			"/api/v1/payments",
			"/api/v1/payments",
		]);
	});

	it("runs a verb name on muse too", async () => {
		const { fetch, requests } = fakeFetch();
		const client = await connect({ surface: "muse", fetch });
		const result = await client.callTool({
			name: "list_products",
			arguments: { account_id: "biz_1" },
		});
		expect(result.isError).toBeFalsy();
		expect(requests).toHaveLength(1);
	});

	it("finds, describes and runs unlisted operations under either name", async () => {
		const { fetch, requests } = fakeFetch();
		const client = await connect({ fetch });
		const search = JSON.parse(
			text(
				await client.callTool({
					name: "search_operations",
					arguments: { query: "payouts_list" },
				}),
			),
		) as { operations: { name: string }[] };
		expect(search.operations[0]?.name).toBe("list_payouts");

		const described = JSON.parse(
			text(
				await client.callTool({
					name: "describe_operation",
					arguments: { name: "payouts_list" },
				}),
			),
		) as { name: string };
		expect(described.name).toBe("list_payouts");

		for (const name of ["payouts_list", "list_payouts"]) {
			const result = await client.callTool({
				name: "call_read_operation",
				arguments: { ...INTENT, name },
			});
			expect(result.isError, name).toBeFalsy();
		}
		expect(requests).toHaveLength(2);
	});

	it("keeps registry names in audit events and API attribution", async () => {
		const { fetch, requests } = fakeFetch();
		const auditSink = new InMemoryAuditSink();
		const client = await connect({ fetch, auditSink });
		await client.callTool({
			name: "list_payments",
			arguments: { ...INTENT, account_id: "biz_1" },
		});
		expect(auditSink.events.map((event) => event.toolName)).toEqual([
			"payments_list",
		]);
		const context = requests[0]?.headers["x-whop-mcp-context"] ?? "";
		const decoded = JSON.parse(
			Buffer.from(
				context.replace(/-/g, "+").replace(/_/g, "/"),
				"base64",
			).toString("utf8"),
		) as { tool_name: string };
		expect(decoded.tool_name).toBe("payments_list");
	});

	it("records which name each call used", async () => {
		const auditSink = new InMemoryAuditSink();
		const client = await connect({ auditSink });
		const payments = { ...INTENT, account_id: "biz_1" };
		await client.callTool({ name: "list_payments", arguments: payments });
		await client.callTool({ name: "payments_list", arguments: payments });
		for (const name of ["list_payouts", "payouts_list"]) {
			await client.callTool({
				name: "call_read_operation",
				arguments: { ...INTENT, name },
			});
		}
		expect(
			auditSink.events.map(({ toolName, calledAs, via }) => ({
				toolName,
				calledAs,
				via,
			})),
		).toEqual([
			{ toolName: "payments_list", calledAs: "verb_name", via: undefined },
			{ toolName: "payments_list", calledAs: "registry_name", via: undefined },
			{
				toolName: "payouts_list",
				calledAs: "verb_name",
				via: "call_read_operation",
			},
			{
				toolName: "payouts_list",
				calledAs: "registry_name",
				via: "call_read_operation",
			},
		]);
	});

	it("names the listed tool in errors", async () => {
		const client = await connect();
		const missing = text(
			await client.callTool({ name: "members_list", arguments: INTENT }),
		);
		expect(missing).toContain("list_members");
		expect(missing).toContain("list_accounts");
		expect(registryNamesIn(missing)).toEqual([]);
	});
});
