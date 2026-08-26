import { describe, expect, it } from "vitest";
import { createSseApiHandler } from "../src/sse-handler.ts";
import type { Env, WhopGrantProps } from "../src/types.ts";

const props: WhopGrantProps = {
	userId: "user_1",
	userName: null,
	mcpClientName: "  Claude 🦄  ",
	profile: "admin",
	whopAccessToken: "access_1",
	whopRefreshToken: "refresh_1",
	whopExpiresAt: Date.now() + 60 * 60 * 1000,
};

describe("SSE handler", () => {
	it("forwards a recovered client name to the open session", async () => {
		let forwardedHeaders = new Headers();
		const env = {
			SSE_SESSIONS: {
				idFromName: () => "session_id",
				get: () => ({
					fetch: async (_input: string, init: RequestInit) => {
						forwardedHeaders = new Headers(init.headers);
						return new Response(null, { status: 202 });
					},
				}),
			},
		} as unknown as Env;
		const ctx = { props } as ExecutionContext;

		const response = await createSseApiHandler().fetch(
			new Request("https://mcp.whop.test/sse/message?sessionId=session", {
				method: "POST",
				body: "{}",
			}),
			env,
			ctx,
		);

		expect(response.status).toBe(202);
		expect(forwardedHeaders.get("x-session-client-name")).toBe("Claude");
	});
});
