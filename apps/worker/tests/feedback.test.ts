import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

const { createMcpApiHandler } = await import("../src/mcp-handler.ts");
import { ApiFeedbackSink } from "../src/feedback.ts";
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
				MCP_CONFIRMATION_SECRET: "test-confirmation-secret-long-enough",
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
							arguments: { content: "The tool documentation is unclear." },
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
			expect(init.headers).toMatchObject({
				Authorization: "Bearer private-access-token",
				"Idempotency-Key": expect.any(String),
			});
			const event = JSON.parse(init.body as string);
			expect(event).toMatchObject({
				source: `mcp_${name}`,
				content: "The tool documentation is unclear.\n\nclient: Test Client",
			});
			expect(event).not.toHaveProperty("user_id");
			expect(JSON.stringify(event)).not.toContain("private-access-token");
			expect(JSON.stringify(event)).not.toContain("private-refresh-token");
		},
	);
});

const submission = {
	id: "test-receipt",
	createdAt: new Date().toISOString(),
	kind: "report_feedback" as const,
	accountId: null,
	fields: { content: "Test" },
};

it.each([301, 302, 307, 308, 400, 401, 429, 500])(
	"rejects an unsuccessful submission response (%s)",
	async (status) => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(new Response("failure", { status })),
		);
		await expect(
			new ApiFeedbackSink("https://api.whop.test", "token").record(submission),
		).rejects.toThrow("Feedback submission failed");
	},
);

it("rejects success without a feedback receipt", async () => {
	vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({})));
	await expect(
		new ApiFeedbackSink("https://api.whop.test", "token").record(submission),
	).rejects.toThrow("Invalid feedback receipt");
});

it("bounds requests and prevents credential forwarding through redirects", async () => {
	const request = vi.fn().mockRejectedValue(new Error("timeout"));
	vi.stubGlobal("fetch", request);
	await expect(
		new ApiFeedbackSink("https://api.whop.test", "token").record(submission),
	).rejects.toThrow("timeout");
	expect(request.mock.calls[0][1]).toMatchObject({
		redirect: "manual",
		signal: expect.any(AbortSignal),
	});
});

it("keeps optional context in the same readable content field", async () => {
	const request = vi.fn().mockResolvedValue(Response.json({ id: "fbk_saved" }));
	vi.stubGlobal("fetch", request);
	await new ApiFeedbackSink("https://api.whop.test", "token").record({
		...submission,
		fields: {
			content: "Request failed",
			intention: "Create a product",
			severity: "blocked",
			workaround: "Used the dashboard",
		},
	});
	expect(JSON.parse(request.mock.calls[0][1].body)).toEqual({
		source: "mcp_report_feedback",
		content:
			"Request failed\n\nintention: Create a product\n\nseverity: blocked\n\nworkaround: Used the dashboard",
	});
});
