import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
	DurableObject: class {
		ctx: unknown;
		env: unknown;
		constructor(ctx: unknown, env: unknown) {
			this.ctx = ctx;
			this.env = env;
		}
	},
}));

const { SseSessionDO } = await import("../src/sse-session-do.ts");
import type { Env, WhopGrantProps } from "../src/types.ts";

const upstreamRequests: {
	url: string;
	authorization: string | null;
	mcpClient: string | null;
	stainlessMcp: string | null;
}[] = [];

function envStub(): Env {
	return {
		MCP_BASE_URL: "https://mcp.whop.test",
		MCP_WHOP_API_ORIGIN: "https://api.whop.test",
		MCP_CONFIRMATION_SECRET: "test-confirmation-secret-long-enough",
		CF_VERSION_METADATA: { id: "test-version" },
		IDEMPOTENCY: {
			idFromName: () => "id",
			get: () => ({
				get: async () => null,
				put: async () => undefined,
				reserve: async () => ({ status: "reserved" }),
				delete: async () => undefined,
			}),
		},
	} as unknown as Env;
}

function propsStub(token: string): WhopGrantProps {
	return {
		userId: "user_1",
		userName: "Test User",
		profile: "admin",
		whopAccessToken: token,
		whopRefreshToken: "refresh_1",
		whopExpiresAt: Date.now() + 3_600_000,
	} as WhopGrantProps;
}

function toolCall(id: number) {
	return {
		jsonrpc: "2.0",
		id,
		method: "tools/call",
		params: {
			name: "products_list",
			// Hosted connections are not account-bound, so the account rides on
			// the call.
			arguments: { account_id: "biz_1" },
		},
	};
}

async function post(
	session: InstanceType<typeof SseSessionDO>,
	path: string,
	body: unknown,
	headers: Record<string, string> = {},
): Promise<Response> {
	return session.fetch(
		new Request(`https://sse-session${path}`, {
			method: "POST",
			headers: { "Content-Type": "application/json", ...headers },
			body: JSON.stringify(body),
		}),
	);
}

/** /message returns 202 before the dispatch settles; wait for the upstream hit. */
async function nextUpstreamRequest(): Promise<
	(typeof upstreamRequests)[number] | undefined
> {
	const before = upstreamRequests.length;
	for (let i = 0; i < 100 && upstreamRequests.length === before; i++) {
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	return upstreamRequests.at(-1);
}

async function openInitializedSession(token: string) {
	const session = new SseSessionDO({} as never, envStub());
	const response = await post(session, "/open", {
		props: propsStub(token),
		endpointUrl: "https://mcp.whop.test/sse/message?sessionId=s",
	});
	// Drain the stream so writes never hit backpressure.
	void (async () => {
		const reader = response.body!.getReader();
		while (!(await reader.read()).done) {
			// discard
		}
	})();
	await post(
		session,
		"/message",
		{
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: {
				protocolVersion: "2024-11-05",
				capabilities: {},
				clientInfo: { name: "legacy-sse-client", version: "1.0" },
			},
		},
		{ "x-session-owner": "user_1" },
	);
	await post(
		session,
		"/message",
		{ jsonrpc: "2.0", method: "notifications/initialized" },
		{ "x-session-owner": "user_1" },
	);
	return session;
}

describe("SseSessionDO upstream credential", () => {
	beforeEach(() => {
		upstreamRequests.length = 0;
		vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
			const headers = new Headers(
				(init?.headers ?? {}) as Record<string, string>,
			);
			upstreamRequests.push({
				url: String(input),
				authorization: headers.get("authorization"),
				mcpClient: headers.get("x-whop-mcp-client"),
				stainlessMcp: headers.get("x-stainless-mcp"),
			});
			return new Response(JSON.stringify({ data: [] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});
	});

	it("uses the token the session was opened with", async () => {
		const session = await openInitializedSession("token_open");
		await post(session, "/message", toolCall(2), {
			"x-session-owner": "user_1",
		});
		expect((await nextUpstreamRequest())?.authorization).toBe(
			"Bearer token_open",
		);
	});

	it("only stamps hosted-worker attribution headers", async () => {
		const session = await openInitializedSession("token_open");
		await post(session, "/message", toolCall(2), {
			"x-session-owner": "user_1",
		});
		const request = await nextUpstreamRequest();
		expect(request?.mcpClient).toBe(
			"whop-mcp-worker/test-version; profile=admin; transport=sse",
		);
		expect(request?.stainlessMcp).toBeNull();
	});

	it("uses the refreshed token a later message carries, not the one from open", async () => {
		const session = await openInitializedSession("token_open");
		await post(session, "/message", toolCall(2), {
			"x-session-owner": "user_1",
			"x-session-token": "token_refreshed",
		});
		expect((await nextUpstreamRequest())?.authorization).toBe(
			"Bearer token_refreshed",
		);
	});

	it("rejects a message from a different user before touching the credential", async () => {
		const session = await openInitializedSession("token_open");
		const before = upstreamRequests.length;
		const response = await post(session, "/message", toolCall(2), {
			"x-session-owner": "user_2",
			"x-session-token": "attacker_token",
		});
		expect(response.status).toBe(403);
		expect(upstreamRequests.length).toBe(before);
	});
});
