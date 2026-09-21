import type { ListToolsResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import {
	createStreamableHttpHandler,
	HttpAuthError,
} from "../src/adapters/streamable-http.ts";
import type { FeedbackSink } from "../src/runtime/feedback.ts";
import {
	buildRealRegistry,
	principalFixture,
	staticCredential,
} from "./helpers.ts";

const registry = buildRealRegistry();

interface ToolResponse {
	result: { isError?: boolean; content: { text: string }[] };
}

function handler(
	feedbackSink?: FeedbackSink,
	accountId: string | null = "biz_boundAccount",
) {
	return createStreamableHttpHandler({
		registry,
		confirmationSecret: "test-confirmation-secret-long-enough",
		feedbackSink,
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

describe("feedback tools over authenticated HTTP", () => {
	it("advertises both write tools only when a feedback sink is configured", async () => {
		for (const enabled of [true, false]) {
			const response = await handler(enabled ? { record: vi.fn() } : undefined)(
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
				expect(tool?.inputSchema.required).toEqual(["content"]);
				expect(tool?.annotations).toMatchObject({
					readOnlyHint: false,
					destructiveHint: false,
					idempotentHint: false,
				});
			}
		}
	});

	it.each(["report_feedback", "ask_question"])(
		"records %s with trusted identity and returns a receipt without an answer",
		async (name) => {
			const record = vi.fn().mockResolvedValue("fbk_saved");
			const response = await handler({ record })(
				request("tools/call", {
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
			expect(record).toHaveBeenCalledExactlyOnceWith({
				id: expect.any(String),
				createdAt: expect.any(String),
				kind: name,
				userId: "user_test1",
				accountId: "biz_boundAccount",
				clientName: "test-client",
				pluginSource: "test-plugin",
				fields: {
					content: "The API returned a confusing error.",
					intention: "Create a product",
					tool: "products_create",
					modelType: "test model",
				},
			});
		},
	);

	it.each(["report_feedback", "ask_question"])(
		"uses explicit account context for %s",
		async (name) => {
			const record = vi.fn().mockResolvedValue("fbk_saved");
			await handler({ record })(
				request("tools/call", {
					name,
					arguments: { content: "A problem", account_id: "biz_resource" },
				}),
			);
			expect(record).toHaveBeenCalledWith(
				expect.objectContaining({
					accountId: "biz_resource",
					userId: "user_test1",
					fields: { content: "A problem" },
				}),
			);
		},
	);

	it("allows accountless submissions", async () => {
		const record = vi.fn().mockResolvedValue("fbk_saved");
		await handler(
			{ record },
			null,
		)(
			request("tools/call", {
				name: "ask_question",
				arguments: { content: "A question" },
			}),
		);
		expect(record).toHaveBeenCalledWith(
			expect.objectContaining({ accountId: null }),
		);
	});

	it("records severity and workaround and scrubs recognized credentials from every supplied field", async () => {
		const record = vi.fn().mockResolvedValue("fbk_saved");
		await handler({ record })(
			request("tools/call", {
				name: "report_feedback",
				arguments: {
					content: "Request with Bearer abc.def failed",
					severity: "degraded",
					workaround: "Tried apik_123456789012 instead",
				},
			}),
		);
		expect(record.mock.calls[0][0].fields).toEqual({
			content: "Request with Bearer [redacted] failed",
			severity: "degraded",
			workaround: "Tried [redacted] instead",
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
	])("rejects invalid or spoofed fields before recording: %j", async (args) => {
		const record = vi.fn();
		const response = await handler({ record })(
			request("tools/call", { name: "report_feedback", arguments: args }),
		);
		const { result } = (await response.json()) as ToolResponse;
		expect(result.isError).toBe(true);
		expect(JSON.parse(result.content[0].text).error.code).toBe("invalid_input");
		expect(record).not.toHaveBeenCalled();
	});

	it("requires authentication before recording", async () => {
		const record = vi.fn();
		const input = request("tools/call", {
			name: "ask_question",
			arguments: { content: "How does this work?" },
		});
		input.headers.delete("Authorization");
		expect((await handler({ record })(input)).status).toBe(401);
		expect(record).not.toHaveBeenCalled();
	});

	it("does not claim success or expose sink errors when recording fails", async () => {
		const record = vi
			.fn()
			.mockRejectedValue(new Error("private storage credentials"));
		const response = await handler({ record })(
			request("tools/call", {
				name: "ask_question",
				arguments: { content: "How does this work?" },
			}),
		);
		const { result } = (await response.json()) as ToolResponse;
		expect(result.isError).toBe(true);
		expect(result.content[0].text).not.toContain("private storage credentials");
		expect(JSON.parse(result.content[0].text).error.code).toBe(
			"internal_error",
		);
	});

	it("rejects direct calls when the tools are not configured", async () => {
		const response = await handler()(
			request("tools/call", {
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
