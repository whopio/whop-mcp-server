import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

const { createMcpApiHandler } = await import("../src/mcp-handler.ts");
import type { Env, WhopGrantProps } from "../src/types.ts";

afterEach(() => {
	vi.unstubAllGlobals();
});

const props: WhopGrantProps = {
	consentVersion: 1,
	whopScope: "openid profile",
	userId: "user_reader",
	userName: "Reader",
	mcpClientName: "Test Client",
	profile: "read_only",
	whopAccessToken: "private-access-token",
	whopRefreshToken: "private-refresh-token",
	whopExpiresAt: Date.now() + 3600000,
};

function env(overrides: Partial<Env> = {}): Env {
	return {
		MCP_BASE_URL: "https://mcp.whop.test",
		MCP_WHOP_API_ORIGIN: "https://api.whop.test",
		MCP_CONFIRMATION_SECRET: "test-confirmation-secret-long-enough",
		CF_VERSION_METADATA: { id: "test-version" },
		...overrides,
	} as Env;
}

async function rpc(
	workerEnv: Env,
	method: string,
	params: Record<string, unknown> = {},
) {
	const response = await createMcpApiHandler().fetch(
		new Request("https://mcp.whop.test/mcp", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
			},
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
		}),
		workerEnv,
		{ props } as unknown as ExecutionContext,
	);
	return response.json<{
		result: {
			tools?: { name: string }[];
			content?: { text: string }[];
			isError?: boolean;
		};
	}>();
}

describe("hosted MCP docs tools", () => {
	it("lists the docs tools for a read-only grant", async () => {
		const { result } = await rpc(env(), "tools/list");
		const names = result.tools?.map((tool) => tool.name);
		expect(names).toContain("docs_search");
		expect(names).toContain("docs_query");
	});

	it("searches the docs server without the user's credential", async () => {
		const request = vi.fn(async (_url: string, _init: RequestInit) =>
			Response.json({
				jsonrpc: "2.0",
				id: 1,
				result: { content: [{ type: "text", text: "Title: Webhooks" }] },
			}),
		);
		vi.stubGlobal("fetch", request);
		const { result } = await rpc(env(), "tools/call", {
			name: "docs_search",
			arguments: { query: "webhooks" },
		});
		expect(result.isError).not.toBe(true);
		expect(result.content?.[0].text).toBe("Title: Webhooks");
		expect(request).toHaveBeenCalledTimes(1);
		const [url, init] = request.mock.calls[0];
		expect(url).toBe("https://docs.whop.com/mcp");
		expect(JSON.stringify(init.headers)).not.toContain("private-access-token");
	});
});
