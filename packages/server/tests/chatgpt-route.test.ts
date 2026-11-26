import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
import {
	CHATGPT_DESTRUCTIVE_WRITES,
	CHATGPT_FLAGGED_KEEP,
	CHATGPT_OPEN_WORLD_WRITES,
	CHATGPT_TOOLS,
} from "../src/policy/chatgpt.ts";
import {
	operationInSurface,
	operationKey,
	type SurfaceName,
} from "../src/policy/surfaces.ts";
import type { PrincipalContext } from "../src/policy/types.ts";
import { visibleOperations } from "../src/policy/visibility.ts";
import {
	CHATGPT_BUILTIN_NAMES,
	CHATGPT_BUILTINS,
} from "../src/runtime/chatgpt-route.ts";
import {
	createWhopMcpServer,
	type ToolListing,
} from "../src/runtime/server.ts";
import { REGISTRY_NAMING, verbNaming } from "../src/runtime/tool-names.ts";
import { InMemoryAuditSink } from "../src/safety/audit.ts";
import {
	buildRealRegistry,
	fakeFetch,
	principalFixture,
	staticCredential,
} from "./helpers.ts";

const registry = buildRealRegistry();
const byKey = new Map(registry.operations.map((op) => [operationKey(op), op]));
const registryNames = new Set(registry.operations.map((op) => op.toolName));
const namingOn = (surface: SurfaceName) =>
	surface === "muse" ? REGISTRY_NAMING : verbNaming(registry.operations);

const CONFIRMATION =
	"This tool acts on the first call. Tell the user what will happen and get their explicit yes before calling it.";
const OTHER_ROUTES_BUILT_IN = [
	"connection_status",
	"docs_search",
	"docs_query",
	"report_feedback",
	"ask_question",
	"search_operations",
	"describe_operation",
	"call_read_operation",
	"call_write_operation",
];
const OTHER_SURFACES = ["full", "claude_directory", "muse"] as const;
const INTENT = {
	intent: "Show me my accounts",
	intent_id: "123e4567-e89b-42d3-a456-426614174000",
};

const allowlistedEntries = Object.entries(CHATGPT_TOOLS) as [string, string][];
const servedOps = registry.operations.filter((op) =>
	operationInSurface(op, "chatgpt"),
);
const listedToolEntries: [string, string][] = [
	...allowlistedEntries.map(
		([opKey, desc]) =>
			[byKey.get(opKey)?.verbName ?? opKey, desc] as [string, string],
	),
	...Object.values(CHATGPT_BUILTINS).map(
		(tool) => [tool.name, tool.description] as [string, string],
	),
];
const allChatgptNames = listedToolEntries.map(([name]) => name);
const confirmedNames = servedOps
	.filter((op) => op.safety.confirmationRequired)
	.map((op) => op.verbName);
const signedInUser = principalFixture({
	principalType: "user",
	accountId: null,
});

async function connect(
	options: {
		surface?: SurfaceName;
		principal?: PrincipalContext;
		fetch?: typeof fetch;
		toolListing?: ToolListing;
		promptsAndResources?: boolean;
		auditSink?: InMemoryAuditSink;
	} = {},
) {
	const { server, operations } = createWhopMcpServer({
		registry,
		surface: options.surface ?? "chatgpt",
		credentialAdapter: staticCredential(),
		principal: options.principal ?? signedInUser,
		fetch: options.fetch ?? fakeFetch().fetch,
		baseUrl: "https://api.whop.test/api/v1",
		chatGptCompat: true,
		docs: true,
		feedback: true,
		toolListing: options.toolListing,
		promptsAndResources: options.promptsAndResources,
		auditSink: options.auditSink,
	});
	const client = new Client({ name: "test-client", version: "1.0.0" });
	const [clientTransport, serverTransport] =
		InMemoryTransport.createLinkedPair();
	await Promise.all([
		server.connect(serverTransport),
		client.connect(clientTransport),
	]);
	return { client, operations };
}

function text(result: unknown): string {
	return (result as { content: { text: string }[] }).content[0].text;
}

function parse(result: unknown): Record<string, unknown> {
	return JSON.parse(text(result));
}

function wholeNames(candidates: string[]): RegExp {
	const alternatives = [...candidates]
		.sort((a, b) => b.length - a.length)
		.map((candidate) => candidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
	return new RegExp(`(?<!\\w)(?:${alternatives.join("|")})(?!\\w)`, "g");
}

function mentioned(haystack: string, pattern: RegExp): string[] {
	return [...new Set(haystack.match(pattern) ?? [])];
}

const unlistedPattern = wholeNames(
	[...registryNames, ...OTHER_ROUTES_BUILT_IN].filter(
		(name) => !allChatgptNames.includes(name),
	),
);

describe("chatgpt-tools.json and policy invariants", () => {
	it("lists only user-callable, surface-allowed operations in the registry", () => {
		for (const [opKey] of allowlistedEntries) {
			const op = byKey.get(opKey);
			expect(op, opKey).toBeDefined();
			expect(op?.principals, opKey).toContain("user");
			expect(operationInSurface(op!, "chatgpt"), opKey).toBe(true);
		}
	});

	it("gives every listed tool a unique snake_case name and plain description", () => {
		expect(new Set(allChatgptNames).size).toBe(allChatgptNames.length);
		expect(
			allChatgptNames.filter((name) => !/^[a-z][a-z0-9_]*$/.test(name)),
		).toEqual([]);
		const listedNames = wholeNames(allChatgptNames);
		for (const [name, description] of listedToolEntries) {
			expect(description, name).toContain("Use this when");
			expect(description.length, name).toBeGreaterThanOrEqual(40);
			expect(description.length, name).toBeLessThanOrEqual(300);
			expect(description, name).not.toContain("`");
			expect(
				mentioned(description, listedNames).filter((hit) => hit !== name),
				name,
			).toEqual([]);
		}
	});

	it("keeps only served operations in override sets and flagged-keep", () => {
		for (const [label, set] of [
			["CHATGPT_DESTRUCTIVE_WRITES", CHATGPT_DESTRUCTIVE_WRITES],
			["CHATGPT_OPEN_WORLD_WRITES", CHATGPT_OPEN_WORLD_WRITES],
			["CHATGPT_FLAGGED_KEEP", CHATGPT_FLAGGED_KEEP],
		] as const) {
			for (const opKey of set) {
				const op = byKey.get(opKey);
				expect(op, `${label} ${opKey}`).toBeDefined();
				expect(operationInSurface(op!, "chatgpt"), `${label} ${opKey}`).toBe(
					true,
				);
				expect(op?.principals, `${label} ${opKey}`).toContain("user");
			}
		}

		const flagged = servedOps
			.filter((op) => op.safety.financial || op.safety.credential)
			.map(operationKey)
			.sort();
		expect(flagged).toEqual([...CHATGPT_FLAGGED_KEEP].sort());
	});

	it("drops newly flagged or unlisted operations on ChatGPT only", () => {
		const unflagged = servedOps.find(
			(op) => !op.safety.financial && !op.safety.credential,
		)!;
		const flagged = {
			...unflagged,
			safety: { ...unflagged.safety, financial: true },
		};
		expect(operationInSurface(flagged, "chatgpt")).toBe(false);
		expect(operationInSurface(flagged, "claude_directory")).toBe(true);

		const unlisted = registry.operations.find(
			(op) =>
				!Object.hasOwn(CHATGPT_TOOLS, operationKey(op)) &&
				!op.safety.financial &&
				!op.safety.credential &&
				operationInSurface(op, "claude_directory"),
		)!;
		expect(operationInSurface(unlisted, "chatgpt")).toBe(false);
		expect(operationInSurface(unlisted, "claude_directory")).toBe(true);
		expect(operationInSurface(unlisted, "full")).toBe(true);
	});
});

describe("ChatGPT route listing, annotations and dispatch", () => {
	it("lists exactly chatgpt-tools.json operations and ChatGPT built-ins regardless of listing options", async () => {
		const { client, operations } = await connect({
			toolListing: "compact",
			promptsAndResources: true,
		});
		const { tools } = await client.listTools();
		expect(tools.map((t) => t.name).sort()).toEqual(
			[...allChatgptNames].sort(),
		);
		expect(operations.map(operationKey).sort()).toEqual(
			allowlistedEntries.map(([opKey]) => opKey).sort(),
		);
		expect(client.getInstructions()).toContain(`(${tools.length} tools)`);
		expect(client.getServerCapabilities()?.prompts).toBeUndefined();
		expect(client.getServerCapabilities()?.resources).toBeUndefined();
		expect(client.getInstructions()).not.toContain("whop://guides/");
		expect(JSON.stringify(tools)).not.toContain("intent_id");
	});

	it("enforces scopes and reflects narrower grants in instructions", async () => {
		const scoped = servedOps.find((op) =>
			op.scopeAlternatives.every((scopes) => scopes.length > 0),
		)!;
		const { client } = await connect({
			principal: principalFixture({
				principalType: "user",
				accountId: null,
				scopes: [],
			}),
		});
		const { tools } = await client.listTools();
		expect(tools.length).toBeLessThan(allChatgptNames.length);
		expect(tools.map((t) => t.name)).not.toContain(scoped.verbName);
		expect(client.getInstructions()).toContain(`(${tools.length} tools)`);
	});

	it("rejects registry names, excluded operations and other routes' built-ins", async () => {
		const { fetch, requests } = fakeFetch();
		const { client } = await connect({ fetch });
		const rejected = [
			"payments_list",
			"accounts_list",
			"products_create",
			"refund_payment",
			"payments_refund",
			"form_company",
			...OTHER_ROUTES_BUILT_IN,
		];
		for (const name of rejected) {
			const result = await client.callTool({ name, arguments: {} });
			expect(result.isError, name).toBe(true);
			expect(parse(result), name).toMatchObject({
				error: { code: "tool_not_found" },
			});
		}
		expect(requests).toHaveLength(0);
	});

	it("audits calls under the registry name without intent headers", async () => {
		const { fetch, requests } = fakeFetch();
		const auditSink = new InMemoryAuditSink();
		const { client } = await connect({ fetch, auditSink });
		const result = await client.callTool({
			name: "list_payments",
			arguments: { account_id: "biz_1" },
		});
		expect(result.isError).toBeFalsy();
		expect(requests[0]?.headers["x-whop-mcp-context"]).toBeUndefined();
		expect(
			auditSink.events.map(({ toolName, calledAs }) => ({
				toolName,
				calledAs,
			})),
		).toEqual([{ toolName: "payments_list", calledAs: "verb_name" }]);
	});

	it("passes the stats platform sentinel through under the route's tool name", async () => {
		const { fetch, requests } = fakeFetch();
		const { client } = await connect({ fetch, principal: principalFixture() });
		const result = await client.callTool({
			name: byKey.get("GET /stats/time_series/{metric}")!.verbName,
			arguments: {
				metric: "gmv_usd",
				account_id: "platform",
				from: "2026-10-01",
				to: "2026-10-18",
			},
		});
		expect(result.isError).toBeFalsy();
		expect(requests[0]?.url).toContain("account_id=platform");
	});

	it("serves exact descriptions, confirmation copy, and OpenAI boolean hints here only", async () => {
		const { client } = await connect();
		const { tools } = await client.listTools();
		const byName = new Map(tools.map((t) => [t.name, t]));
		const described = new Map(listedToolEntries);

		for (const tool of tools) {
			const expected = described.get(tool.name);
			expect(tool.description, tool.name).toBe(
				confirmedNames.includes(tool.name)
					? `${expected}\n\n${CONFIRMATION}`
					: expected,
			);
			for (const hint of [
				"readOnlyHint",
				"destructiveHint",
				"openWorldHint",
			] as const) {
				expect(typeof tool.annotations?.[hint], `${tool.name} ${hint}`).toBe(
					"boolean",
				);
			}
		}

		for (const op of servedOps) {
			const ann = byName.get(op.verbName)?.annotations;
			expect(ann?.destructiveHint, op.verbName).toBe(
				op.annotations.destructiveHint ||
					CHATGPT_DESTRUCTIVE_WRITES.has(operationKey(op)),
			);
			expect(ann?.openWorldHint, op.verbName).toBe(
				op.annotations.openWorldHint ||
					CHATGPT_OPEN_WORLD_WRITES.has(operationKey(op)),
			);
		}

		const full = await connect({ surface: "full" });
		const fullTools = new Map(
			(await full.client.listTools()).tools.map((t) => [t.name, t]),
		);
		expect(JSON.stringify([...fullTools.values()])).not.toContain(CONFIRMATION);
		for (const opKey of CHATGPT_DESTRUCTIVE_WRITES) {
			const op = byKey.get(opKey)!;
			expect(fullTools.get(op.verbName)?.annotations?.destructiveHint).toBe(
				op.annotations.destructiveHint,
			);
		}
		for (const opKey of CHATGPT_OPEN_WORLD_WRITES) {
			const op = byKey.get(opKey)!;
			expect(fullTools.get(op.verbName)?.annotations?.openWorldHint).toBe(
				op.annotations.openWorldHint,
			);
		}
	});
});

describe("ChatGPT instructions, errors and built-ins", () => {
	const page = `Title: Webhooks\nPage: developer/guides/webhooks\n${"x".repeat(2100)}`;
	const docsFetch = (parts: string[]) =>
		fakeFetch(() => ({
			body: {
				jsonrpc: "2.0",
				id: 1,
				result: {
					content: parts.map((part) => ({ type: "text", text: part })),
				},
			},
		}));

	it("puts confirmation and unavailable rules in the first 512 chars and mentions no unlisted tool", async () => {
		const { client } = await connect();
		const instructions = client.getInstructions() ?? "";
		const head = instructions.slice(0, 512);
		expect(head).toContain("get their explicit yes");
		expect(head).toContain("say so, offer no workaround.");
		expect(instructions).toContain("Do not volunteer customers'");
		expect(instructions).toContain(
			"find it with list_accounts if they name it",
		);
		expect(instructions).toContain(
			`Call ${CHATGPT_BUILTINS.connection_status.name} to see the signed-in user`,
		);
		expect(mentioned(instructions, unlistedPattern)).toEqual([]);

		// Money-movement endpoints promised unavailable in instructions stay off.
		const leftOut =
			/^POST \/(payments(\/\{id\}\/(refund|retry|capture))?|invoices(\/\{id\}\/(charge|issue|send))?)$|^[A-Z]+ \/(payouts|transfers|claim_links)(\/|$)/;
		expect(servedOps.map(operationKey).filter((k) => leftOut.test(k))).toEqual(
			[],
		);

		for (const tool of (await client.listTools()).tools) {
			expect(
				mentioned(JSON.stringify(tool), unlistedPattern),
				tool.name,
			).toEqual([]);
		}

		for (const surface of ["full", "claude_directory"] as const) {
			const other = (await connect({ surface })).client.getInstructions() ?? "";
			expect(other).not.toContain("offer no workaround");
			expect(other).not.toContain("Do not volunteer customers'");
		}
	});

	it("names listed tools in validation errors and drops request_id only on ChatGPT", async () => {
		const { fetch } = fakeFetch(() => ({
			status: 404,
			body: { error: { message: "Not found" } },
			headers: { "x-request-id": "req_1" },
		}));
		const auditSink = new InMemoryAuditSink();
		const { client, operations } = await connect({ fetch, auditSink });

		const needsBusiness = operations.find(
			(op) =>
				op.accountParam !== null &&
				op.requiresAccount &&
				(op.inputSchema.required ?? []).length === 0,
		)!;
		const missing = text(
			await client.callTool({ name: needsBusiness.verbName, arguments: {} }),
		);
		expect(missing).toContain("account_required");
		expect(missing).toContain(needsBusiness.verbName);
		expect(missing).toContain("find it with list_accounts");
		expect(mentioned(missing, unlistedPattern)).toEqual([]);

		const upstream = parse(
			await client.callTool({
				name: "get_account",
				arguments: { id: "biz_1" },
			}),
		);
		expect(upstream.error).not.toHaveProperty("request_id");
		expect(auditSink.events.at(-1)?.requestId).toBe("req_1");

		const fullAudit = new InMemoryAuditSink();
		const full = await connect({
			surface: "full",
			fetch,
			auditSink: fullAudit,
		});
		const fullReply = parse(
			await full.client.callTool({
				name: "get_account",
				arguments: { ...INTENT, id: "biz_1" },
			}),
		);
		expect((fullReply.error as Record<string, unknown>).request_id).toBe(
			"req_1",
		);
		expect(fullAudit.events.at(-1)?.requestId).toBe("req_1");
	});

	it("trims get_connection_status and leaves connection_status intact elsewhere", async () => {
		const { client } = await connect();
		const { tools } = await client.listTools();
		const status = parse(
			await client.callTool({
				name: CHATGPT_BUILTINS.connection_status.name,
				arguments: {},
			}),
		);
		expect(Object.keys(status).sort()).toEqual([
			"account_id",
			"account_title",
			"permission_profile",
			"tool_categories",
			"tool_count",
			"user_name",
		]);
		expect(status.tool_count).toBe(tools.length);
		expect(
			Object.values(status.tool_categories as Record<string, number>).reduce(
				(sum, n) => sum + n,
				0,
			),
		).toBe(servedOps.length);

		const full = await connect({ surface: "full" });
		const fullStatus = parse(
			await full.client.callTool({ name: "connection_status", arguments: {} }),
		);
		expect(Object.keys(fullStatus)).toEqual(
			expect.arrayContaining(["granted_scopes", "server_version"]),
		);
	});

	it("scopes search without account_id on ChatGPT and keeps account_id elsewhere", async () => {
		const { fetch, requests } = fakeFetch(() => ({ body: { data: [] } }));
		const { client } = await connect({ fetch });
		const search = (await client.listTools()).tools.find(
			(t) => t.name === "search",
		);
		expect(Object.keys(search?.inputSchema.properties ?? {})).toEqual([
			"query",
		]);
		await client.callTool({ name: "search", arguments: { query: "x" } });
		expect(requests.map((r) => new URL(r.url).pathname).sort()).toEqual([
			"/api/v1/payments",
			"/api/v1/products",
		]);

		const full = await connect({ surface: "full" });
		const fullSearch = (await full.client.listTools()).tools.find(
			(t) => t.name === "search",
		);
		expect(fullSearch?.inputSchema.properties).toHaveProperty("account_id");
	});

	it("serves search_docs alone without mentioning docs_query, keeping docs_query elsewhere", async () => {
		const { fetch, requests } = docsFetch([page]);
		const { client } = await connect({ fetch });
		const name = CHATGPT_BUILTINS.docs_search.name;
		const result = await client.callTool({
			name,
			arguments: { query: "hooks" },
		});
		expect(text(result).endsWith("[Excerpt trimmed.]")).toBe(true);
		expect(mentioned(text(result), unlistedPattern)).toEqual([]);
		expect(requests[0]?.url).toBe("https://docs.whop.com/mcp");
		expect(requests[0]?.headers.authorization).toBeUndefined();

		const invalid = text(await client.callTool({ name, arguments: {} }));
		expect(invalid).toContain(`Invalid ${name} input`);
		expect(mentioned(invalid, unlistedPattern)).toEqual([]);

		const long = await connect({
			fetch: docsFetch(Array.from({ length: 300 }, () => page)).fetch,
		});
		const truncated = text(
			await long.client.callTool({ name, arguments: { query: "hooks" } }),
		);
		expect(truncated.endsWith("characters. Narrow the search.]")).toBe(true);
		expect(mentioned(truncated, unlistedPattern)).toEqual([]);

		const full = await connect({
			surface: "full",
			fetch: docsFetch([page]).fetch,
		});
		const fullRes = text(
			await full.client.callTool({
				name: "docs_search",
				arguments: { query: "hooks" },
			}),
		);
		expect(fullRes).toContain("Read the full page with docs_query");
	});

	it.each(OTHER_SURFACES)(
		"leaves %s listing straight from the registry",
		async (surface) => {
			const { client } = await connect({ surface });
			const { tools } = await client.listTools();
			const expected = visibleOperations(registry, signedInUser, { surface });
			const naming = namingOn(surface);
			const opNames = new Set(expected.map((op) => naming.name(op.toolName)));

			expect(
				tools
					.filter((t) => opNames.has(t.name))
					.map(({ name, description, annotations }) => ({
						name,
						description,
						annotations,
					})),
			).toEqual(
				expected.map((op) => ({
					name: naming.name(op.toolName),
					description: naming.inText(op.description || op.summary || ""),
					annotations: { ...op.annotations, title: op.summary },
				})),
			);
			expect(
				tools.filter((t) => !opNames.has(t.name)).map((t) => t.name),
			).toEqual([
				"search",
				"fetch",
				"report_feedback",
				"ask_question",
				"docs_search",
				"docs_query",
				"connection_status",
			]);
			expect(
				tools
					.map((t) => t.name)
					.filter(
						(name) =>
							CHATGPT_BUILTIN_NAMES.includes(name) &&
							!["search", "fetch"].includes(name),
					),
			).toEqual([]);
		},
	);
});
