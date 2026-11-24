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
import { CHATGPT_BUILTIN_NAMES, operationInSurface } from "@whop/mcp-server";
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

async function call(
	path: string,
	profile: string,
	method: string,
	params?: unknown,
): Promise<{ result: Record<string, unknown> }> {
	const response = await captured.handlers[path].fetch(
		new Request(`https://mcp.whop.test${path}`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
			},
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
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
	return (await response.json()) as { result: Record<string, unknown> };
}

async function toolNames(path: string, profile: string): Promise<string[]> {
	const { result } = await call(path, profile, "tools/list");
	return (result.tools as { name: string }[]).map((tool) => tool.name);
}

async function capabilities(
	path: string,
	profile: string,
): Promise<Record<string, unknown>> {
	const { result } = await call(path, profile, "initialize", {
		protocolVersion: "2025-06-18",
		capabilities: {},
		clientInfo: { name: "test", version: "1" },
	});
	return result.capabilities as Record<string, unknown>;
}

describe("route table", () => {
	it("serves each route its own surface and listing", async () => {
		const full = await toolNames("/mcp", "admin");
		expect(full).toContain("refund_payment");
		expect(full).toContain("search_operations");
		expect(full).not.toContain("payments_refund");
		expect(full).not.toContain("create_transfer");
		const claude = await toolNames("/claude/mcp", "admin");
		expect(claude).toContain("refund_payment");
		expect(claude).toContain("search_operations");
		expect(claude).not.toContain("generate_media_asset");
		expect(claude).not.toContain("create_transfer");
		const chatgpt = await toolNames("/chatgpt/mcp", "chatgpt");
		const expectedChatgpt = [
			...registry.operations
				.filter((op) => operationInSurface(op, "chatgpt"))
				.map((op) => op.verbName),
			...CHATGPT_BUILTIN_NAMES,
		];
		expect(chatgpt).toContain("search");
		expect(expectedChatgpt).toEqual(expect.arrayContaining(chatgpt));
		expect(chatgpt).not.toContain("refund_payment");
		expect(chatgpt).not.toContain("create_transfer");
		expect(chatgpt).not.toContain("search_operations");
		const muse = await toolNames("/muse/mcp", "muse");
		expect(muse).toContain("payments_list");
		expect(muse).toContain("search_operations");
		expect(muse).toContain("payments_refund");
		expect(muse).toContain("memberships_cancel");
		expect(muse).not.toContain("payouts_create");
		expect(muse).not.toContain("call_write_operation");
	});

	it("serves the guides on /mcp and /muse/mcp only", async () => {
		for (const [path, profile] of [
			["/mcp", "admin"],
			["/muse/mcp", "muse"],
		]) {
			const caps = await capabilities(path, profile);
			expect(caps).toHaveProperty("prompts");
			expect(caps).toHaveProperty("resources");
		}
		for (const [path, profile] of [
			["/claude/mcp", "admin"],
			["/chatgpt/mcp", "chatgpt"],
		]) {
			const caps = await capabilities(path, profile);
			expect(caps).not.toHaveProperty("prompts");
			expect(caps).not.toHaveProperty("resources");
		}
	});
});
