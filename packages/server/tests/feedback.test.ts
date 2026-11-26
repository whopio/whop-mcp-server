import type { ListToolsResult } from "@modelcontextprotocol/server";
import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
	createStreamableHttpHandler,
	HttpAuthError,
} from "../src/adapters/streamable-http.ts";
import type { SurfaceName } from "../src/policy/surfaces.ts";
import {
	buildRealRegistry,
	fakeFetch,
	principalFixture,
	staticCredential,
} from "./helpers.ts";

const registry = buildRealRegistry();

interface ToolResponse {
	result: { isError?: boolean; content: { text: string }[] };
}

function api(body: unknown = { id: "fbk_saved" }) {
	return fakeFetch(() => ({ status: 202, body }));
}

function handler(
	whopApi?: ReturnType<typeof api>,
	accountId: string | null = "biz_boundAccount",
	surface?: SurfaceName,
) {
	return createStreamableHttpHandler({
		registry,
		feedback: whopApi !== undefined,
		fetch: whopApi?.fetch,
		baseUrl: "https://api.whop.test/api/v1",
		surface,
		authenticator: {
			async authenticate(request) {
				if (request.headers.get("Authorization") !== "Bearer test-token") {
					throw new HttpAuthError(401, "Authentication required");
				}
				return {
					principal: { ...principalFixture(), accountId },
					credentialAdapter: staticCredential(),
					clientName: "test-client",
					pluginSource: "test-plugin",
				};
			},
		},
	});
}

function request(method: string, params: Record<string, unknown> = {}) {
	return new Request("https://mcp.whop.test/mcp", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
			Authorization: "Bearer test-token",
		},
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
	});
}

const INTENT = {
	intent: "Why did my product fail to publish?",
	intent_id: "123e4567-e89b-42d3-a456-426614174000",
};

function toolCall(
	params: { name: string; arguments: Record<string, unknown> },
	intent: Record<string, unknown> = INTENT,
) {
	return request("tools/call", {
		...params,
		arguments: { ...intent, ...params.arguments },
	});
}

describe("feedback tools over authenticated HTTP", () => {
	it("advertises both write tools only when feedback is enabled", async () => {
		for (const enabled of [true, false]) {
			const response = await handler(enabled ? api() : undefined)(
				request("tools/list"),
			);
			const { result } = (await response.json()) as { result: ListToolsResult };
			for (const name of ["report_feedback", "ask_question"]) {
				const tool = result.tools.find(
					(tool: { name: string }) => tool.name === name,
				);
				if (!enabled) {
					expect(tool).toBeUndefined();
					continue;
				}
				expect(tool?.inputSchema.required).toEqual([
					"content",
					"intent",
					"intent_id",
				]);
				expect(tool?.annotations).toMatchObject({
					readOnlyHint: false,
					destructiveHint: false,
					idempotentHint: false,
				});
			}
		}
	});

	it.each(["report_feedback", "ask_question"])(
		"sends %s to the Whop API with the user's intent and returns a receipt without an answer",
		async (name) => {
			const whopApi = api();
			const response = await handler(whopApi)(
				toolCall({
					name,
					arguments: {
						content: "The API returned a confusing error.",
						intention: "Create a product",
						tool: "products_create",
						modelType: "test model",
					},
				}),
			);
			const { result } = (await response.json()) as ToolResponse;
			expect(result.isError).not.toBe(true);
			const receipt = JSON.parse(result.content[0].text);
			expect(receipt.status).toBe("submitted");
			expect(receipt.submission_id).toBe("fbk_saved");
			expect(receipt.message).toContain(
				name === "ask_question" ? "No answer" : "No follow-up",
			);
			expect(whopApi.requests).toHaveLength(1);
			const [sent] = whopApi.requests;
			expect(sent).toMatchObject({
				url: "https://api.whop.test/api/v1/feedback_submissions",
				method: "POST",
				redirect: "manual",
				headers: { "idempotency-key": expect.any(String) },
				body: {
					account_id: "biz_boundAccount",
					source: `mcp_${name}`,
					content:
						"The API returned a confusing error.\n\nintention: Create a product\n\ntool: products_create\n\nmodelType: test model\n\nclient: test-client\n\nplugin: test-plugin",
				},
			});
			expect(
				JSON.parse(
					Buffer.from(sent.headers["x-whop-mcp-context"], "base64url").toString(
						"utf8",
					),
				),
			).toMatchObject({
				intent: INTENT.intent,
				intent_id: INTENT.intent_id,
				tool_name: name,
				tool_call_id: expect.stringMatching(
					/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
				),
			});
		},
	);

	it.each(["report_feedback", "ask_question"])(
		"uses explicit account context for %s",
		async (name) => {
			const whopApi = api();
			await handler(whopApi)(
				toolCall({
					name,
					arguments: { content: "A problem", account_id: "biz_resource" },
				}),
			);
			expect(whopApi.requests[0].body).toMatchObject({
				account_id: "biz_resource",
				content: "A problem\n\nclient: test-client\n\nplugin: test-plugin",
			});
		},
	);

	it("allows accountless submissions", async () => {
		const whopApi = api();
		await handler(
			whopApi,
			null,
		)(
			toolCall({
				name: "ask_question",
				arguments: { content: "A question" },
			}),
		);
		expect(whopApi.requests[0].body).not.toHaveProperty("account_id");
	});

	it("sends severity and workaround and scrubs recognized credentials from every supplied field", async () => {
		const whopApi = api();
		await handler(whopApi)(
			toolCall({
				name: "report_feedback",
				arguments: {
					content: "Request with Bearer abc.def failed",
					severity: "degraded",
					workaround: "Tried apik_123456789012 instead",
				},
			}),
		);
		expect(whopApi.requests[0].body).toMatchObject({
			content:
				"Request with Bearer [redacted] failed\n\nseverity: degraded\n\nworkaround: Tried [redacted] instead\n\nclient: test-client\n\nplugin: test-plugin",
		});
	});

	it.each([
		{},
		{ content: " " },
		{ content: 42 },
		{ content: "Valid", account_id: null },
		{ content: "Valid", account_id: 42 },
		{ content: "Valid", account_id: "user_wrong" },
		{ content: "Valid", account_id: "biz_invalid/path" },
		{ content: "Valid", account_id: "biz_" + "a".repeat(252) },

		{ content: "x".repeat(12001) },
		{ content: "Valid", intention: "x".repeat(2001) },
		{ content: "Valid", severity: "critical" },
		{ content: "Valid", userId: "user_spoofed" },
		{ content: "Valid", accountId: "biz_spoofed" },
		{ content: "Valid", workaround: " " },
	])("rejects invalid or spoofed fields before sending: %j", async (args) => {
		const whopApi = api();
		const response = await handler(whopApi)(
			toolCall({ name: "report_feedback", arguments: args }),
		);
		const { result } = (await response.json()) as ToolResponse;
		expect(result.isError).toBe(true);
		expect(JSON.parse(result.content[0].text).error.code).toBe("invalid_input");
		expect(whopApi.requests).toHaveLength(0);
	});

	it.each([
		{},
		{ intent: INTENT.intent },
		{ intent_id: INTENT.intent_id },
		{ intent: " ", intent_id: INTENT.intent_id },
		{ intent: INTENT.intent, intent_id: "not-a-uuid" },
	])("requires the user's intent before sending: %j", async (intent) => {
		const whopApi = api();
		const response = await handler(whopApi)(
			toolCall(
				{ name: "report_feedback", arguments: { content: "A real issue" } },
				intent,
			),
		);
		const { result } = (await response.json()) as ToolResponse;
		expect(result.isError).toBe(true);
		expect(JSON.parse(result.content[0].text).error.code).toBe("invalid_input");
		expect(whopApi.requests).toHaveLength(0);
	});

	// The ChatGPT route serves only its allowlisted operations and five built-ins,
	// so the feedback tools are excluded.
	it("keeps the feedback tools off the ChatGPT route, which asks for no intent and sends no context", async () => {
		const whopApi = api({ data: [] });
		const chatgpt = handler(whopApi, "biz_boundAccount", "chatgpt");
		const listed = (await (await chatgpt(request("tools/list"))).json()) as {
			result: ListToolsResult;
		};
		const names = listed.result.tools.map((tool) => tool.name);
		expect(names).not.toContain("report_feedback");
		expect(names).not.toContain("ask_question");
		expect(names).toContain("list_products");
		for (const tool of listed.result.tools) {
			expect(tool.inputSchema.properties ?? {}, tool.name).not.toHaveProperty(
				"intent",
			);
		}

		const response = await chatgpt(
			request("tools/call", { name: "list_products", arguments: {} }),
		);
		const { result } = (await response.json()) as ToolResponse;
		expect(result.isError).not.toBe(true);
		expect(whopApi.requests[0].headers).not.toHaveProperty(
			"x-whop-mcp-context",
		);
	});

	it("requires authentication before sending", async () => {
		const whopApi = api();
		const input = toolCall({
			name: "ask_question",
			arguments: { content: "How does this work?" },
		});
		input.headers.delete("Authorization");
		expect((await handler(whopApi)(input)).status).toBe(401);
		expect(whopApi.requests).toHaveLength(0);
	});

	it("does not claim success without a feedback receipt", async () => {
		const response = await handler(api({}))(
			toolCall({
				name: "ask_question",
				arguments: { content: "How does this work?" },
			}),
		);
		const { result } = (await response.json()) as ToolResponse;
		expect(result.isError).toBe(true);
		expect(JSON.parse(result.content[0].text).error.code).toBe(
			"internal_error",
		);
	});

	it("rejects direct calls when the tools are not configured", async () => {
		const response = await handler()(
			toolCall({
				name: "report_feedback",
				arguments: { content: "A real issue" },
			}),
		);
		const { result } = (await response.json()) as ToolResponse;
		expect(JSON.parse(result.content[0].text).error.code).toBe(
			"tool_not_found",
		);
	});
});
