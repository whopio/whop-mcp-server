import { describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({
	handlers: {} as Record<
		string,
		{ fetch(request: Request, env: unknown, ctx: unknown): Promise<Response> }
	>,
}));

vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));
vi.mock("@cloudflare/workers-oauth-provider", () => ({
	default: class {
		constructor(options: { apiHandlers: typeof captured.handlers }) {
			captured.handlers = options.apiHandlers;
		}
	},
	getOAuthApi: () => ({}),
	GrantType: {
		AUTHORIZATION_CODE: "authorization_code",
		REFRESH_TOKEN: "refresh_token",
	},
	OAuthError: class extends Error {},
}));

await import("../src/index.ts");
import {
	expandChatgptToWhopScopes,
	expandMuseToWhopScopes,
	expandProfileToWhopScopes,
} from "../src/profile-scopes.ts";
import { registry } from "../src/registry.ts";

const grantedScopes: Record<string, string> = {
	admin: expandProfileToWhopScopes("admin", registry.operations).join(" "),
	chatgpt: expandChatgptToWhopScopes(registry.operations).join(" "),
	muse: expandMuseToWhopScopes(registry.operations).join(" "),
};

const env = {
	MCP_BASE_URL: "https://mcp.whop.test",
	MCP_WHOP_API_ORIGIN: "https://api.whop.test",
	CF_VERSION_METADATA: { id: "test-version" },
};

async function toolNames(path: string, profile: string): Promise<string[]> {
	const response = await captured.handlers[path].fetch(
		new Request(`https://mcp.whop.test${path}`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
			},
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
		}),
		env,
		{
			props: {
				consentVersion: 1,
				whopScope: grantedScopes[profile],
				userId: "user_1",
				profile,
				whopAccessToken: "a",
				whopRefreshToken: "r",
				whopExpiresAt: Date.now() + 3600000,
			},
		},
	);
	expect(response.status).toBe(200);
	const body = (await response.json()) as {
		result: { tools: { name: string }[] };
	};
	return body.result.tools.map((tool) => tool.name);
}

describe("route table", () => {
	it("serves each route its own surface and listing", async () => {
		const full = await toolNames("/mcp", "admin");
		expect(full).toContain("payments_refund");
		expect(full).toContain("search_operations");
		expect(full).not.toContain("transfers_create");
		const claude = await toolNames("/claude/mcp", "admin");
		expect(claude).toContain("payments_refund");
		expect(claude).toContain("search_operations");
		expect(claude).not.toContain("media_generate");
		expect(claude).not.toContain("transfers_create");
		const chatgpt = await toolNames("/chatgpt/mcp", "chatgpt");
		expect(chatgpt).toContain("media_generate");
		expect(chatgpt).toContain("domains_create");
		expect(chatgpt).not.toContain("payments_refund");
		expect(chatgpt).not.toContain("transfers_create");
		expect(chatgpt).not.toContain("search_operations");
		const muse = await toolNames("/muse/mcp", "muse");
		expect(muse).toContain("payments_list");
		expect(muse).toContain("search_operations");
		expect(muse).not.toContain("payments_refund");
		expect(muse).not.toContain("call_write_operation");
	});
});
