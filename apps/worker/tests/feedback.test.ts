import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

const { createMcpApiHandler } = await import("../src/mcp-handler.ts");
import type { Env, WhopGrantProps } from "../src/types.ts";

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("hosted MCP feedback submissions", () => {
	it.each(["report_feedback", "ask_question"])(
		"submits %s through the authenticated backend",
		async (name) => {
			const request = vi.fn(async (_url: URL, _init: RequestInit) =>
				Response.json({ id: "fbk_saved" }, { status: 202 }),
			);
			vi.stubGlobal("fetch", request);
			const props: WhopGrantProps = {
				consentVersion: 1,
				whopScope: "openid profile",
				userId: "user_reporter",
				userName: "Reporter",
				mcpClientName: "Test Client",
				profile: "admin",
				whopAccessToken: "private-access-token",
				whopRefreshToken: "private-refresh-token",
				whopExpiresAt: Date.now() + 3600000,
			};
			const env = {
				MCP_BASE_URL: "https://mcp.whop.test",
				MCP_WHOP_API_ORIGIN: "https://api.whop.test",
				CF_VERSION_METADATA: { id: "test-version" },
			} as Env;
			const response = await createMcpApiHandler().fetch(
				new Request("https://mcp.whop.test/mcp", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Accept: "application/json, text/event-stream",
					},
					body: JSON.stringify({
						jsonrpc: "2.0",
						id: 1,
						method: "tools/call",
						params: {
							name,
							arguments: {
								content: "The tool documentation is unclear.",
								account_id: "biz_resource",
								intent: "Why won't my product publish?",
								intent_id: "123e4567-e89b-42d3-a456-426614174000",
							},
						},
					}),
				}),
				env,
				{ props } as unknown as ExecutionContext,
			);
			const body = await response.json<{
				result: { content: { text: string }[]; isError?: boolean };
			}>();
			expect(body.result.isError).not.toBe(true);
			const receipt = JSON.parse(body.result.content[0].text);
			expect(request).toHaveBeenCalledTimes(1);
			expect(receipt.submission_id).toBe("fbk_saved");
			const [url, init] = request.mock.calls[0];
			expect(url.toString()).toBe(
				"https://api.whop.test/api/v1/feedback_submissions",
			);
			const headers = init.headers as Record<string, string>;
			expect(headers).toMatchObject({
				Authorization: "Bearer private-access-token",
				"Idempotency-Key": expect.any(String),
				"x-whop-mcp-client-name": "Test Client",
			});
			const context = JSON.parse(
				atob(
					headers["X-Whop-MCP-Context"].replace(/-/g, "+").replace(/_/g, "/"),
				),
			);
			expect(context).toMatchObject({
				version: 1,
				intent: "Why won't my product publish?",
				intent_id: "123e4567-e89b-42d3-a456-426614174000",
				tool_name: name,
				tool_call_id: expect.any(String),
			});
			const event = JSON.parse(init.body as string);
			expect(event).toMatchObject({
				source: `mcp_${name}`,
				account_id: "biz_resource",
				content: "The tool documentation is unclear.\n\nclient: Test Client",
			});
			expect(event).not.toHaveProperty("user_id");
			expect(JSON.stringify(event)).not.toContain("private-access-token");
			expect(JSON.stringify(event)).not.toContain("private-refresh-token");
		},
	);
});
