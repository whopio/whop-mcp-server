import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import type { PrincipalContext } from "../src/policy/types.ts";
import { InMemoryAuditSink } from "../src/safety/audit.ts";
import { WhopMcpError } from "../src/runtime/errors.ts";
import { createWhopMcpServer } from "../src/runtime/server.ts";
import {
	CHATGPT_DESTRUCTIVE_WRITES,
	CHATGPT_EXCLUSIONS,
	CHATGPT_OPEN_WORLD_WRITES,
	CLAUDE_DIRECTORY_EXCLUSIONS,
	operationInSurface,
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
		chatGptCompat?: boolean;
	} = {},
) {
	const { server } = createWhopMcpServer({
		registry,
		surface: options.surface,
		chatGptCompat: options.chatGptCompat,
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

	it("records the upstream status when a call fails", async () => {
		const { fetch } = fakeFetch(() => ({
			status: 403,
			body: { error: { type: "forbidden", message: "Not allowed" } },
		}));
		const auditSink = new InMemoryAuditSink();
		const client = await connect({ fetch, auditSink });

		const result = await client.callTool({
			name: "payments_list",
			arguments: {},
		});
		expect(result.isError).toBe(true);
		expect(auditSink.events).toHaveLength(1);
		expect(auditSink.events[0]).toMatchObject({
			outcome: "failed",
			toolName: "payments_list",
			upstreamStatus: 403,
		});
		expect(auditSink.events[0].errorCode).toEqual(expect.any(String));
	});

	it("leaves upstreamStatus unset when the call fails before reaching the API", async () => {
		const { fetch, requests } = fakeFetch();
		const auditSink = new InMemoryAuditSink();
		const client = await connect({ fetch, auditSink });

		const result = await client.callTool({
			name: "payments_get",
			arguments: {},
		});
		expect(result.isError).toBe(true);
		expect(requests).toHaveLength(0);
		expect(auditSink.events[0]).toMatchObject({
			outcome: "failed",
			errorCode: "invalid_input",
		});
		expect(auditSink.events[0].upstreamStatus).toBeUndefined();
	});

	it("does not offer API-key-only tools to a user token", async () => {
		const client = await connect({
			principal: principalFixture({ principalType: "user", accountId: null }),
		});
		const names = (await client.listTools()).tools.map((t) => t.name);
		expect(names).not.toContain("accounts_me");
		expect(names).not.toContain("account-links_create");
		expect(names).toContain("accounts_list");
	});

	it("hides tools whose scopes the user token was not granted", async () => {
		const client = await connect({
			principal: principalFixture({
				principalType: "user",
				accountId: null,
				scopes: ["openid", "payment:basic:read"],
			}),
		});
		const names = (await client.listTools()).tools.map((t) => t.name);
		expect(names).toContain("payments_list");
		expect(names).not.toContain("ad-pixels_list");
		expect(names).not.toContain("payments_refund");
		expect(names).toContain("connection_status");
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
		for (const excluded of CLAUDE_DIRECTORY_EXCLUSIONS) {
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

describe("chatgpt surface", () => {
	const key = (op: { method: string; path: string }) =>
		`${op.method.toUpperCase()} ${op.path}`;

	// A red row may be a rename: re-key it to the new path. Deleting it puts the tool back on this route.
	it("names only operations that exist in the registry", () => {
		const keys = new Set(registry.operations.map(key));
		for (const excluded of CHATGPT_EXCLUSIONS) {
			expect(keys, excluded).toContain(excluded);
		}
	});

	it("lists as destructive only writes a signed-in user can reach here", () => {
		const byKey = new Map(registry.operations.map((op) => [key(op), op]));
		for (const listed of CHATGPT_DESTRUCTIVE_WRITES) {
			const op = byKey.get(listed);
			if (!op) throw new Error(`${listed} is not in the registry`);
			expect(operationInSurface(op, "chatgpt"), listed).toBe(true);
			expect(op.principals, listed).toContain("user");
		}
	});

	it("marks the listed writes destructive here and leaves the older routes alone", async () => {
		const hints = async (surface: SurfaceName) => {
			const client = await connect({
				surface,
				principal: principalFixture({ principalType: "user", accountId: null }),
			});
			const { tools } = await client.listTools();
			return new Map(
				tools.map((tool) => [tool.name, tool.annotations?.destructiveHint]),
			);
		};
		const listed = registry.operations.filter((op) =>
			CHATGPT_DESTRUCTIVE_WRITES.has(key(op)),
		);
		expect(listed).toHaveLength(CHATGPT_DESTRUCTIVE_WRITES.size);

		const chatgpt = await hints("chatgpt");
		for (const op of listed) {
			expect(chatgpt.get(op.toolName), op.toolName).toBe(true);
		}
		expect(chatgpt.get("members_notes_create")).toBe(false);
		expect(chatgpt.get("products_create")).toBe(false);

		for (const surface of ["full", "claude_directory"] as const) {
			const older = await hints(surface);
			const shown = listed.filter((op) => older.has(op.toolName));
			expect(shown.length, surface).toBeGreaterThan(0);
			for (const op of shown) {
				expect(older.get(op.toolName), `${surface} ${op.toolName}`).toBe(
					op.annotations.destructiveHint,
				);
			}
		}
	});

	it("marks writes that reach the public as open world here only", async () => {
		const hints = async (surface: SurfaceName) => {
			const client = await connect({
				surface,
				principal: principalFixture({ principalType: "user", accountId: null }),
			});
			const { tools } = await client.listTools();
			return new Map(
				tools.map((tool) => [tool.name, tool.annotations?.openWorldHint]),
			);
		};
		const listed = registry.operations.filter((op) =>
			CHATGPT_OPEN_WORLD_WRITES.has(key(op)),
		);
		expect(listed).toHaveLength(CHATGPT_OPEN_WORLD_WRITES.size);

		const chatgpt = await hints("chatgpt");
		for (const op of listed) {
			expect(chatgpt.get(op.toolName), op.toolName).toBe(true);
		}
		expect(chatgpt.get("products_create")).toBe(false);

		const full = await hints("full");
		for (const op of listed) {
			expect(full.get(op.toolName), op.toolName).toBe(
				op.annotations.openWorldHint,
			);
		}
	});

	const builtinTools = async (surface: SurfaceName) => {
		const client = await connect({
			surface,
			chatGptCompat: true,
			principal: principalFixture({ principalType: "user", accountId: null }),
		});
		return (await client.listTools()).tools;
	};

	it("gives every listed tool OpenAI's three hints as booleans", async () => {
		const tools = await builtinTools("chatgpt");
		expect(tools.map((tool) => tool.name)).toEqual(
			expect.arrayContaining(["search", "fetch", "connection_status"]),
		);
		for (const tool of tools) {
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
	});

	it("says what search can reach here and leaves the older routes alone", async () => {
		const search = (await builtinTools("chatgpt")).find(
			(tool) => tool.name === "search",
		);
		expect(search?.description).toContain("marketplace");
		expect(search?.description).not.toContain("connected Whop account");

		for (const surface of ["full", "claude_directory"] as const) {
			const older = (await builtinTools(surface)).find(
				(tool) => tool.name === "search",
			);
			expect(older?.description).toContain("connected Whop account");
			expect(older?.annotations).toEqual({ readOnlyHint: true });
		}
	});

	it("searches only what answers without a business on the ChatGPT route", async () => {
		const queried = async (surface: SurfaceName) => {
			const { fetch, requests } = fakeFetch(() => ({ body: { data: [] } }));
			const client = await connect({
				surface,
				chatGptCompat: true,
				fetch,
				principal: principalFixture({ principalType: "user", accountId: null }),
			});
			await client.callTool({ name: "search", arguments: { query: "x" } });
			return requests.map((request) => new URL(request.url).pathname);
		};

		const chatgpt = await queried("chatgpt");
		expect(chatgpt).toHaveLength(2);
		expect(chatgpt.some((path) => path.endsWith("/products"))).toBe(true);
		expect(chatgpt.some((path) => path.endsWith("/payments"))).toBe(true);

		const full = await queried("full");
		expect(full.some((path) => path.endsWith("/members"))).toBe(true);
	});

	const userPrincipal = () =>
		principalFixture({ principalType: "user", accountId: null });

	// Holds whether or not this route collects intent, so that commit can revert.
	const connectAsRoute = async (options: Parameters<typeof connect>[0]) => {
		const client = await connect({ ...options, includeIntent: false });
		const { tools } = await client.listTools();
		const accountsGet = tools.find((tool) => tool.name === "accounts_get");
		return accountsGet?.inputSchema.properties?.intent
			? withTestIntent(client)
			: client;
	};

	it("trims connection_status here and leaves the older routes alone", async () => {
		const open = async (surface: SurfaceName) => {
			const client = await connectAsRoute({
				surface,
				principal: userPrincipal(),
			});
			return {
				status: parseResult(
					await client.callTool({ name: "connection_status", arguments: {} }),
				),
				description: (await client.listTools()).tools.find(
					(tool) => tool.name === "connection_status",
				)?.description,
				instructions: client.getInstructions(),
			};
		};

		const chatgpt = await open("chatgpt");
		expect(Object.keys(chatgpt.status).sort()).toEqual([
			"account_id",
			"account_title",
			"permission_profile",
			"tool_categories",
			"tool_count",
			"user_name",
		]);
		for (const word of ["diagnostics", "build metadata", "scopes"]) {
			expect(chatgpt.description).not.toContain(word);
		}
		expect(chatgpt.instructions).toContain(
			"Call connection_status to see the signed-in user",
		);

		for (const surface of ["full", "claude_directory"] as const) {
			const older = await open(surface);
			expect(Object.keys(older.status)).toEqual(
				expect.arrayContaining([
					"granted_scopes",
					"server_version",
					"openapi_sha256",
				]),
			);
			expect(older.description).toContain("build metadata");
			expect(older.instructions).toContain(
				"Call connection_status to see the authenticated identity",
			);
		}
	});

	it("leaves tax IDs out of accounts_list here, and nowhere else", async () => {
		const row = {
			id: "biz_1",
			title: "Acme",
			tax_identifiers: [{ tax_id_type: "br_cpf", tax_id_value: "000" }],
		};
		const read = async (surface: SurfaceName) => {
			const { fetch } = fakeFetch((request) => ({
				body: request.url.includes("/accounts/biz_1")
					? row
					: { data: [row], page_info: { has_next_page: false } },
			}));
			const client = await connectAsRoute({
				surface,
				fetch,
				principal: userPrincipal(),
			});
			return {
				list: parseResult(
					await client.callTool({ name: "accounts_list", arguments: {} }),
				),
				get: parseResult(
					await client.callTool({
						name: "accounts_get",
						arguments: { id: "biz_1" },
					}),
				),
			};
		};

		const chatgpt = await read("chatgpt");
		expect(chatgpt.list).toEqual({
			data: [{ id: "biz_1", title: "Acme" }],
			page_info: { has_next_page: false },
		});
		expect(chatgpt.get).toEqual(row);

		for (const surface of ["full", "claude_directory"] as const) {
			const older = await read(surface);
			expect(older.list.data).toEqual([row]);
			expect(older.get).toEqual(row);
		}
	});

	it("keeps request IDs out of error replies here, and in the audit log", async () => {
		const fail = async (surface: SurfaceName) => {
			const auditSink = new InMemoryAuditSink();
			const { fetch } = fakeFetch(() => ({
				status: 404,
				body: { error: { message: "Not found" } },
				headers: { "x-request-id": "req_1" },
			}));
			const client = await connectAsRoute({
				surface,
				fetch,
				auditSink,
				principal: userPrincipal(),
			});
			const reply = parseResult(
				await client.callTool({
					name: "accounts_get",
					arguments: { id: "biz_1" },
				}),
			);
			return {
				error: reply.error as Record<string, unknown>,
				audit: auditSink.events.at(-1),
			};
		};

		const chatgpt = await fail("chatgpt");
		expect(chatgpt.error.code).toBeDefined();
		expect(chatgpt.error).not.toHaveProperty("request_id");
		expect(chatgpt.audit?.requestId).toBe("req_1");

		for (const surface of ["full", "claude_directory"] as const) {
			const older = await fail(surface);
			expect(older.error.request_id).toBe("req_1");
			expect(older.audit?.requestId).toBeFalsy();
		}
	});

	it("asks for a yes before consequential calls, on this route only", async () => {
		const text = async (surface: SurfaceName) => {
			const client = await connect({
				surface,
				fetch: fakeFetch().fetch,
				principal: principalFixture({ principalType: "user", accountId: null }),
			});
			const { tools } = await client.listTools();
			return {
				instructions: client.getInstructions(),
				tools,
			};
		};
		const chatgpt = await text("chatgpt");
		expect(chatgpt.instructions).toContain(
			"Consequential tools (anything that costs money, goes live, affects other people, or can't be undone) act on the first call, so never call one just to see a preview. Tell the user what will happen, get their explicit yes, then call it.",
		);
		// OpenAI says to keep the most important details in the first 512 characters.
		expect(chatgpt.instructions?.slice(0, 512)).toContain(
			"get their explicit yes",
		);
		const consequential = new Set(
			registry.operations
				.filter((op) => op.safety.confirmationRequired)
				.map((op) => op.toolName),
		);
		const asks = chatgpt.tools.filter((tool) =>
			tool.description?.includes("get their explicit yes before calling it"),
		);
		expect(asks.length).toBeGreaterThan(0);
		expect(asks.map((tool) => tool.name).sort()).toEqual(
			chatgpt.tools
				.map((tool) => tool.name)
				.filter((name) => consequential.has(name))
				.sort(),
		);

		for (const surface of ["full", "claude_directory"] as const) {
			const older = await text(surface);
			expect(older.instructions).toContain("intent_id");
			expect(older.instructions).not.toContain("explicit yes");
			expect(JSON.stringify(older.tools)).not.toContain("explicit yes");
			expect(JSON.stringify(older.tools)).toContain("intent_id");
		}
	});

	it("keeps only the chosen financial and credential operations", () => {
		const flagged = registry.operations
			.filter(
				(op) =>
					operationInSurface(op, "chatgpt") &&
					(op.safety.financial || op.safety.credential),
			)
			.map(key)
			.sort();
		expect(flagged).toEqual([
			"PATCH /domains/{id}",
			"POST /domains",
			"POST /media/generate",
		]);
	});

	it("drops a newly flagged operation on this surface only", () => {
		const unexcluded = registry.operations.find(
			(op) => key(op) === "POST /products",
		);
		expect(unexcluded).toBeDefined();
		const flagged = {
			...unexcluded!,
			safety: { ...unexcluded!.safety, financial: true },
		};
		expect(operationInSurface(unexcluded!, "chatgpt")).toBe(true);
		expect(operationInSurface(flagged, "chatgpt")).toBe(false);
		expect(operationInSurface(flagged, "claude_directory")).toBe(true);
	});

	it("takes calls without intent fields", async () => {
		const { fetch, requests } = fakeFetch();
		const client = await connect({
			surface: "chatgpt",
			fetch,
			includeIntent: false,
			principal: principalFixture({ principalType: "user", accountId: null }),
		});
		const { tools } = await client.listTools();
		expect(JSON.stringify(tools)).not.toContain("intent_id");
		expect(client.getInstructions()).not.toContain("intent_id");

		const result = await client.callTool({
			name: "products_list",
			arguments: { account_id: "biz_1" },
		});
		expect(result.isError).toBeFalsy();
		expect(requests).toHaveLength(1);
		expect(requests[0].url).toContain("account_id=biz_1");
		expect(requests[0].headers["x-whop-mcp-context"]).toBeUndefined();
	});

	it("runs a consequential tool without intent fields", async () => {
		const { fetch, requests } = fakeFetch(() => ({ body: { id: "x" } }));
		const client = await connect({
			surface: "chatgpt",
			fetch,
			includeIntent: false,
			principal: principalFixture({ principalType: "user", accountId: null }),
		});
		const args = { account_id: "biz_1", type: "image", prompt: "a cat" };

		const first = await client.callTool({
			name: "media_generate",
			arguments: args,
		});
		expect(first.isError).toBeFalsy();
		expect(requests).toHaveLength(1);
		expect(requests[0].body).toMatchObject({ prompt: "a cat" });
		expect(requests[0].headers["x-whop-mcp-context"]).toBeUndefined();
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
