import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import type { PrincipalContext } from "../src/policy/types.ts";
import { InMemoryAuditSink } from "../src/safety/audit.ts";
import { WhopMcpError } from "../src/runtime/errors.ts";
import { createWhopMcpServer } from "../src/runtime/server.ts";
import {
	CLAUDE_DIRECTORY_EXCLUSIONS,
	type SurfaceName,
} from "../src/policy/surfaces.ts";
import {
	buildRealRegistry,
	fakeFetch,
	principalFixture,
	staticCredential,
} from "./helpers.ts";

const registry = buildRealRegistry();
const TEST_INTENT = "Show me my products";
const TEST_INTENT_ID = "123e4567-e89b-42d3-a456-426614174000";

function withTestIntent(client: Client): Client {
	const callTool = client.callTool.bind(client);
	const callToolWithIntent: typeof client.callTool = (
		params,
		resultSchema,
		requestOptions,
	) =>
		callTool(
			params.name === "connection_status"
				? params
				: {
						...params,
						arguments: {
							intent: TEST_INTENT,
							intent_id: TEST_INTENT_ID,
							...params.arguments,
						},
					},
			resultSchema,
			requestOptions,
		);
	client.callTool = callToolWithIntent;
	return client;
}

async function connect(
	options: {
		principal?: PrincipalContext;
		fetch?: typeof fetch;
		auditSink?: InMemoryAuditSink;
		beforeCall?: Parameters<typeof createWhopMcpServer>[0]["beforeCall"];
		includeIntent?: boolean;
		surface?: SurfaceName;
	} = {},
) {
	const { server } = createWhopMcpServer({
		registry,
		surface: options.surface,
		credentialAdapter: staticCredential(),
		principal: options.principal ?? principalFixture(),
		fetch: options.fetch ?? fakeFetch().fetch,
		auditSink: options.auditSink,
		beforeCall: options.beforeCall,
		baseUrl: "https://api.whop.test/api/v1",
	});
	const client = new Client({ name: "test-client", version: "1.0.0" });
	const [clientTransport, serverTransport] =
		InMemoryTransport.createLinkedPair();
	await Promise.all([
		server.connect(serverTransport),
		client.connect(clientTransport),
	]);
	return options.includeIntent === false ? client : withTestIntent(client);
}

function parseResult(result: unknown): Record<string, unknown> {
	const content = (result as { content: { type: string; text: string }[] })
		.content;
	return JSON.parse(content[0].text);
}

function decodeMcpContext(value: string): Record<string, unknown> {
	return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
}

describe("MCP contract", () => {
	it("initializes and lists tools including connection_status", async () => {
		const client = await connect();
		const { tools } = await client.listTools();
		const names = tools.map((t) => t.name);
		expect(names).toContain("accounts_me");
		expect(names).toContain("connection_status");
		expect(names).toContain("payments_refund");
		const businessOps = registry.operations.filter((op) =>
			op.principals.includes("business"),
		);
		expect(tools.length).toBe(businessOps.length + 1);
		for (const tool of tools) {
			if (tool.name === "connection_status") {
				expect(tool.inputSchema.properties).not.toHaveProperty("intent");
				expect(tool.inputSchema.properties).not.toHaveProperty("intent_id");
				continue;
			}
			expect(tool.inputSchema.properties?.intent).toMatchObject({
				type: "string",
				pattern: "\\S",
			});
			expect(tool.inputSchema.properties?.intent_id).toMatchObject({
				type: "string",
				format: "uuid",
			});
			expect(tool.inputSchema.required).toEqual(
				expect.arrayContaining(["intent", "intent_id"]),
			);
		}
	});

	it("filters tools by permission profile", async () => {
		const client = await connect({
			principal: principalFixture({ permissionProfile: "read_only" }),
		});
		const { tools } = await client.listTools();
		const registryTools = tools.filter((t) => t.name !== "connection_status");
		expect(registryTools.length).toBeGreaterThan(100);
		for (const tool of registryTools) {
			expect(tool.annotations?.readOnlyHint, tool.name).toBe(true);
		}
	});

	it("filters tools by granted scopes", async () => {
		const granted = ["company:basic:read"];
		const client = await connect({
			principal: principalFixture({
				permissionProfile: "admin",
				scopes: granted,
			}),
		});
		const { tools } = await client.listTools();
		expect(tools.length).toBeLessThan(registry.operations.length + 1);
		for (const tool of tools) {
			if (tool.name === "connection_status") continue;
			const op = registry.operations.find((o) => o.toolName === tool.name)!;
			expect(
				op.scopeAlternatives.some((alternative) =>
					alternative.every((scope) => granted.includes(scope)),
				),
				tool.name,
			).toBe(true);
		}
	});

	it("shows a tool when one OpenAPI scope alternative is granted", async () => {
		const client = await connect({
			principal: principalFixture({
				permissionProfile: "standard",
				scopes: ["support_chat:message:create", "dms:channel:manage"],
			}),
		});
		const { tools } = await client.listTools();
		expect(tools.map((tool) => tool.name)).toContain("messages_create");
		expect(tools.map((tool) => tool.name)).not.toContain(
			"channel-members_delete",
		);
	});

	it("requires every scope within an OpenAPI alternative", async () => {
		const client = await connect({
			principal: principalFixture({
				permissionProfile: "standard",
				scopes: ["dms:channel:manage", "support_chat:read"],
			}),
		});
		const { tools } = await client.listTools();
		expect(tools.map((tool) => tool.name)).toContain("channel-members_delete");
	});

	it("executes a read tool against the API", async () => {
		const { fetch, requests } = fakeFetch(() => ({
			body: { data: [{ id: "prod_1" }] },
		}));
		const client = await connect({ fetch });
		const result = await client.callTool({
			name: "products_list",
			arguments: {},
		});
		expect(parseResult(result)).toEqual({ data: [{ id: "prod_1" }] });
		expect(requests[0].url).toContain("/products");
		expect(requests[0].url).not.toContain("intent");
		expect(requests[0].body).toBeUndefined();
		const context = decodeMcpContext(requests[0].headers["x-whop-mcp-context"]);
		expect(context).toMatchObject({
			version: 1,
			intent: TEST_INTENT,
			intent_id: TEST_INTENT_ID,
			intent_char_count: Array.from(TEST_INTENT).length,
			intent_truncated: false,
			tool_name: "products_list",
		});
		expect(context.tool_call_id).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
		);
	});

	it("rejects missing or invalid intent attribution before dispatch", async () => {
		const { fetch, requests } = fakeFetch();
		const client = await connect({ fetch, includeIntent: false });
		for (const arguments_ of [
			{},
			{ intent: "   ", intent_id: TEST_INTENT_ID },
			{ intent: TEST_INTENT, intent_id: "not-a-uuid" },
			{ intent: 42, intent_id: TEST_INTENT_ID },
		]) {
			const result = await client.callTool({
				name: "products_list",
				arguments: arguments_,
			});
			expect(result.isError).toBe(true);
			expect(parseResult(result)).toMatchObject({
				error: { code: "invalid_input" },
			});
		}
		expect(requests).toHaveLength(0);
	});

	it("uses separate tool-call IDs for overlapping intent text", async () => {
		const { fetch, requests } = fakeFetch();
		const client = await connect({ fetch });
		await client.callTool({
			name: "products_list",
			arguments: { intent: "Make my ads better" },
		});
		await client.callTool({
			name: "products_list",
			arguments: {
				intent: "Make my ads better",
				intent_id: "223e4567-e89b-42d3-a456-426614174000",
			},
		});
		const contexts = requests.map((request) =>
			decodeMcpContext(request.headers["x-whop-mcp-context"]),
		);
		expect(contexts.map((context) => context.intent)).toEqual([
			"Make my ads better",
			"Make my ads better",
		]);
		expect(contexts.map((context) => context.intent_id)).toEqual([
			TEST_INTENT_ID,
			"223e4567-e89b-42d3-a456-426614174000",
		]);
		expect(contexts[0].tool_call_id).not.toBe(contexts[1].tool_call_id);
	});

	it.each(["user", "business", "app"] as const)(
		"exposes native stats and rejects legacy stats for %s credentials",
		async (principalType) => {
			const { fetch, requests } = fakeFetch();
			const client = await connect({
				fetch,
				principal: principalFixture({
					principalType,
					scopes: ["stats:read"],
					permissionProfile: "read_only",
				}),
			});
			const { tools } = await client.listTools();
			expect(
				tools
					.filter((tool) => tool.name.startsWith("stats_"))
					.map((tool) => tool.name)
					.sort(),
			).toEqual([
				"stats_get",
				"stats_list",
				"stats_reports_list",
				"stats_time-series_get",
				"stats_time-series_list",
			]);
			await client.callTool({ name: "stats_list", arguments: {} });
			expect(new URL(requests[0].url).pathname).toBe("/api/v1/stats");
			const funnel = await client.callTool({
				name: "stats_get",
				arguments: {
					metric: "funnel",
					account_id: "biz_boundAccount",
					from: "2026-09-01",
					to: "2026-09-14",
					steps: {
						"1": { event: "pixel.page", page: "/pricing*" },
						"2": { event: "payment.completed", plan_id: "plan_monthly" },
					},
				},
			});
			expect(funnel.isError).not.toBe(true);
			const funnelUrl = new URL(requests[1].url);
			expect(funnelUrl.pathname).toBe("/api/v1/stats/funnel");
			expect(funnelUrl.searchParams.get("steps[1][event]")).toBe("pixel.page");
			expect(funnelUrl.searchParams.get("steps[1][page]")).toBe("/pricing*");
			expect(funnelUrl.searchParams.get("steps[2][event]")).toBe(
				"payment.completed",
			);
			expect(funnelUrl.searchParams.get("steps[2][plan_id]")).toBe(
				"plan_monthly",
			);
			for (const name of ["stats_describe", "stats_metric", "stats_raw"]) {
				const result = await client.callTool({ name, arguments: {} });
				expect(result.isError).toBe(true);
				expect(parseResult(result)).toMatchObject({
					error: { code: "tool_not_found" },
				});
			}
			expect(requests).toHaveLength(2);
			await client.close();
		},
	);

	it("returns a structured error for unknown tools", async () => {
		const client = await connect();
		const result = await client.callTool({
			name: "not_a_tool",
			arguments: {},
		});
		expect(result.isError).toBe(true);
		expect(parseResult(result)).toMatchObject({
			error: { code: "tool_not_found" },
		});
	});

	it("executes a financial mutation in one call", async () => {
		const { fetch, requests } = fakeFetch(() => ({
			body: { id: "pay_1", status: "refunded" },
		}));
		const auditSink = new InMemoryAuditSink();
		const client = await connect({ fetch, auditSink });

		const executed = parseResult(
			await client.callTool({
				name: "payments_refund",
				arguments: { id: "pay_123456", idempotency_key: "retry-1" },
			}),
		);
		expect(executed).toEqual({ id: "pay_1", status: "refunded" });
		expect(requests.length).toBe(1);
		expect(requests[0].headers["idempotency-key"]).toBe("retry-1");
		expect(requests[0].body ?? {}).not.toHaveProperty("intent");
		expect(requests[0].body ?? {}).not.toHaveProperty("intent_id");
		expect(requests[0].body ?? {}).not.toHaveProperty("idempotency_key");
		expect(
			decodeMcpContext(requests[0].headers["x-whop-mcp-context"]),
		).toMatchObject({
			intent: TEST_INTENT,
			intent_id: TEST_INTENT_ID,
			tool_name: "payments_refund",
		});
		expect(auditSink.events.map((e) => e.outcome)).toEqual(["executed"]);
	});

	it("sends an operation's own confirmation_token argument upstream", async () => {
		const operation = registry.operations.find(
			(op) => op.method === "post" && op.path === "/setup_intents",
		)!;
		const { fetch, requests } = fakeFetch(() => ({
			body: { id: "sint_1", status: "requires_action" },
		}));
		const client = await connect({ fetch });
		const { tools } = await client.listTools();
		const tool = tools.find(
			(candidate) => candidate.name === operation.toolName,
		)!;
		const properties = (
			tool.inputSchema as { properties: Record<string, unknown> }
		).properties;
		expect(properties).toHaveProperty("confirmation_token");
		expect(properties).not.toHaveProperty("mcp_confirmation_token");

		const result = parseResult(
			await client.callTool({
				name: operation.toolName,
				arguments: { confirmation_token: "ctok_buyer_method" },
			}),
		);
		expect(result).toEqual({ id: "sint_1", status: "requires_action" });
		expect(requests).toHaveLength(1);
		expect(requests[0].body).toMatchObject({
			account_id: "biz_boundAccount",
			confirmation_token: "ctok_buyer_method",
		});
	});

	it("does not describe a two-step flow to the model", async () => {
		const client = await connect();
		expect(client.getInstructions()).not.toMatch(/two-step|confirmation/i);
		const { tools } = await client.listTools();
		const refund = tools.find((t) => t.name === "payments_refund")!;
		expect(refund.description).not.toMatch(/two-step|confirmation token/i);
	});

	it("rejects cross-account input through the full stack", async () => {
		const client = await connect();
		const result = await client.callTool({
			name: "products_list",
			arguments: { account_id: "biz_someoneElse" },
		});
		expect(result.isError).toBe(true);
		expect(parseResult(result)).toMatchObject({
			error: { code: "account_mismatch" },
		});
	});

	it("allows any business on an unbound connection", async () => {
		const client = await connect({
			principal: principalFixture({ accountId: null }),
		});
		for (const account of ["biz_first", "biz_second"]) {
			const result = await client.callTool({
				name: "products_list",
				arguments: { account_id: account },
			});
			expect(result.isError).toBeFalsy();
		}
	});

	it("requires the account param in the advertised schema only when no account is bound", async () => {
		const requiredFor = async (accountId: string | null) => {
			const client = await connect({
				principal: principalFixture({ accountId }),
			});
			const { tools } = await client.listTools();
			return tools.find((t) => t.name === "accounts_preferences")?.inputSchema
				.required;
		};
		expect(await requiredFor(null)).toContain("account_id");
		expect(await requiredFor("biz_boundAccount")).not.toContain("account_id");
	});

	it("reports safe connection diagnostics without credentials", async () => {
		const client = await connect();
		const status = parseResult(
			await client.callTool({ name: "connection_status", arguments: {} }),
		);
		expect(status).toMatchObject({
			account_id: "biz_boundAccount",
			principal_type: "business",
			permission_profile: "admin",
			api_version_date: registry.meta.apiVersionDate,
			openapi_sha256: registry.meta.openapiSha256,
		});
		expect(JSON.stringify(status)).not.toContain("apik_");
		expect(status.tool_count).toBe(
			registry.operations.filter((op) => op.principals.includes("business"))
				.length,
		);
	});
});

describe("claude_directory surface", () => {
	const key = (op: { method: string; path: string }) =>
		`${op.method.toUpperCase()} ${op.path}`;

	it("names only operations that exist in the registry", () => {
		const keys = new Set(registry.operations.map(key));
		for (const excluded of CLAUDE_DIRECTORY_EXCLUSIONS.keys()) {
			expect(keys, excluded).toContain(excluded);
		}
	});

	// Every financial write still reachable on the directory surface. A new
	// financial operation fails this test until someone decides whether it
	// moves money out of the account (add it to CLAUDE_DIRECTORY_EXCLUSIONS)
	// or not (add it here).
	it("pins the financial writes left on the surface", () => {
		const remaining = registry.operations
			.filter(
				(op) =>
					op.safety.financial &&
					op.method.toUpperCase() !== "GET" &&
					!CLAUDE_DIRECTORY_EXCLUSIONS.has(key(op)),
			)
			.map(key)
			.sort();
		expect(remaining).toEqual(
			[
				"DELETE /fee_markups/{id}",
				"PATCH /cashback_rules/{id}",
				"PATCH /domains/{id}",
				"PATCH /invoices/{id}",
				"PATCH /payments/{id}",
				"PATCH /payments/{payment_id}/return_url",
				"PATCH /setup_intents/{setup_intent_id}/return_url",
				"POST /ad_campaigns/{id}/retry_payment",
				"POST /cashback_rule",
				"POST /company_token_transactions",
				"POST /disputes/{id}/accept",
				"POST /domains",
				"POST /fee_markups",
				"POST /invoices",
				"POST /invoices/{id}/charge",
				"POST /invoices/{id}/issue",
				"POST /invoices/{id}/mark_uncollectible",
				"POST /invoices/{id}/send",
				"POST /invoices/{id}/unschedule",
				"POST /invoices/{id}/void",
				"POST /memberships/{id}/apply_promo_code",
				"POST /memberships/{id}/assign_affiliate",
				"POST /memberships/{id}/extend",
				"POST /memberships/{id}/reactivate",
				"POST /partner_referral_requests/{id}/accept",
				"POST /partners/businesses/{id}/resend_invite",
				"POST /payment_method_domains",
				"POST /payment_method_domains/{id}/verify",
				"POST /payments",
				"POST /payments/{id}/capture",
				"POST /payments/{id}/refund",
				"POST /payments/{id}/retry",
				"POST /payments/{id}/void",
				"POST /payments/{payment_id}/resume",
				"POST /resolution_center_cases/{id}/accept",
				"POST /setup_intents",
				"POST /waitlist_entries/approve_all",
				"POST /waitlist_entries/{id}/approve",
			].sort(),
		);
	});

	it("hides media generation and money-out tools but keeps selling", async () => {
		const client = await connect({ surface: "claude_directory" });
		const names = (await client.listTools()).tools.map((t) => t.name);
		for (const hidden of [
			"media_generate",
			"transfers_create",
			"payouts_create",
			"bounties_create",
			"deposits_create",
			"trades_create",
		]) {
			expect(names).not.toContain(hidden);
		}
		for (const kept of [
			"payments_refund",
			"products_create",
			"payouts_list",
			"transfers_list",
			"connection_status",
		]) {
			expect(names).toContain(kept);
		}
	});

	it("rejects a direct call to an excluded tool", async () => {
		const { fetch, requests } = fakeFetch();
		const client = await connect({ surface: "claude_directory", fetch });
		const result = await client.callTool({
			name: "transfers_create",
			arguments: { amount: 10 },
		});
		expect(result.isError).toBe(true);
		expect(JSON.stringify(parseResult(result))).toContain("tool_not_found");
		expect(requests).toHaveLength(0);
	});

	it("reports the surface in connection_status", async () => {
		const client = await connect({ surface: "claude_directory" });
		const status = parseResult(
			await client.callTool({ name: "connection_status", arguments: {} }),
		);
		expect(status.tool_surface).toBe("claude_directory");
		expect(status.tool_count).toBe(
			registry.operations.filter(
				(op) =>
					op.principals.includes("business") &&
					!CLAUDE_DIRECTORY_EXCLUSIONS.has(key(op)),
			).length,
		);
	});
});

describe("direct execution and policy hooks", () => {
	async function connectWith(
		options: Parameters<typeof createWhopMcpServer>[0],
	) {
		const { server } = createWhopMcpServer(options);
		const client = new Client({ name: "test-client", version: "1.0.0" });
		const [clientTransport, serverTransport] =
			InMemoryTransport.createLinkedPair();
		await Promise.all([
			server.connect(serverTransport),
			client.connect(clientTransport),
		]);
		return withTestIntent(client);
	}

	it("executes confirmation-required tools directly", async () => {
		const { fetch, requests } = fakeFetch(() => ({ body: { id: "pay_1" } }));
		const client = await connectWith({
			registry,
			credentialAdapter: staticCredential(),
			principal: principalFixture(),
			fetch,
			baseUrl: "https://api.whop.test/api/v1",
		});
		const result = parseResult(
			await client.callTool({
				name: "payments_refund",
				arguments: { id: "pay_123456" },
			}),
		);
		expect(result).toEqual({ id: "pay_1" });
		expect(requests.length).toBe(1);
		expect(requests[0].headers["idempotency-key"]).toBeTruthy();
	});

	it("offers idempotency_key on confirmation-required tools", async () => {
		const client = await connectWith({
			registry,
			credentialAdapter: staticCredential(),
			principal: principalFixture(),
			fetch: fakeFetch().fetch,
		});
		const { tools } = await client.listTools();
		const refund = tools.find((t) => t.name === "payments_refund")!;
		const properties = Object.keys(
			(refund.inputSchema as { properties: Record<string, unknown> })
				.properties,
		);
		expect(properties).not.toContain("mcp_confirmation_token");
		// A retried execution must reuse the same key or the upstream 24h
		// replay cannot prevent double execution.
		expect(properties).toContain("idempotency_key");
	});

	it("forwards a caller-supplied idempotency key", async () => {
		const { fetch, requests } = fakeFetch(() => ({ body: { id: "pay_1" } }));
		const client = await connectWith({
			registry,
			credentialAdapter: staticCredential(),
			principal: principalFixture(),
			fetch,
			baseUrl: "https://api.whop.test/api/v1",
		});
		await client.callTool({
			name: "payments_refund",
			arguments: { id: "pay_123456", idempotency_key: "retry-key-1" },
		});
		expect(requests[0].headers["idempotency-key"]).toBe("retry-key-1");
	});

	it("restricts the surface with nativeOnly", async () => {
		const client = await connectWith({
			registry,
			credentialAdapter: staticCredential(),
			principal: principalFixture(),
			nativeOnly: true,
			fetch: fakeFetch().fetch,
		});
		const { tools } = await client.listTools();
		const nativeBusinessOps = registry.operations.filter(
			(op) => op.surface === "native" && op.principals.includes("business"),
		);
		expect(tools.length).toBe(nativeBusinessOps.length + 1);
		expect(tools.map((t) => t.name)).not.toContain("affiliates_archive");
	});

	it("lets beforeCall block an execution", async () => {
		const { fetch, requests } = fakeFetch();
		const client = await connectWith({
			registry,
			credentialAdapter: staticCredential(),
			principal: principalFixture(),
			fetch,
			beforeCall: async (operation) => {
				if (operation.safety.financial) {
					throw new WhopMcpError(
						"missing_scope",
						"Financial operations are blocked by policy.",
					);
				}
			},
		});
		const blocked = await client.callTool({
			name: "payments_refund",
			arguments: { id: "pay_123456" },
		});
		expect(blocked.isError).toBe(true);
		expect(parseResult(blocked)).toMatchObject({
			error: { code: "missing_scope" },
		});
		expect(requests.length).toBe(0);

		const allowed = await client.callTool({
			name: "products_list",
			arguments: {},
		});
		expect(allowed.isError).toBeFalsy();
		expect(requests.length).toBe(1);
	});
});
