import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

const { createMcpApiHandler } = await import("../src/mcp-handler.ts");
import type { SurfaceName } from "@whop/mcp-server";
import { expandProfileToWhopScopes } from "../src/profile-scopes.ts";
import { registry } from "../src/registry.ts";
import type { Env, WhopGrantProps } from "../src/types.ts";

const adminGrantScope = expandProfileToWhopScopes(
	"admin",
	registry.operations,
).join(" ");

const props: WhopGrantProps = {
	consentVersion: 1,
	whopScope: adminGrantScope,
	userId: "user_lister",
	userName: "Lister",
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

async function listToolNames(
	surface: SurfaceName | undefined,
	path: string,
	grant: WhopGrantProps = props,
): Promise<string[]> {
	const response = await createMcpApiHandler(surface).fetch(
		new Request(`https://mcp.whop.test${path}`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
			},
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
		}),
		env,
		{ props: grant } as unknown as ExecutionContext,
	);
	expect(response.status).toBe(200);
	const body = (await response.json()) as {
		result: { tools: { name: string }[] };
	};
	return body.result.tools.map((tool) => tool.name);
}

describe("per-route tool surfaces", () => {
	it("serves the full surface on /mcp", async () => {
		const names = await listToolNames(undefined, "/mcp");
		expect(names).toContain("media_generate");
		expect(names).toContain("transfers_create");
	});

	it("drops media generation and money-out tools on /claude/mcp", async () => {
		const names = await listToolNames("claude_directory", "/claude/mcp");
		expect(names).not.toContain("media_generate");
		expect(names).not.toContain("transfers_create");
		expect(names).not.toContain("payouts_create");
		expect(names).toContain("payments_refund");
		expect(names).toContain("connection_status");
	});

	it("hides tools whose scopes the token was never granted", async () => {
		const names = await listToolNames(undefined, "/mcp");
		expect(names).not.toContain("ad-pixels_list");
		expect(names).not.toContain("automations_list");
		expect(names).toContain("ai-chats_list");
	});

	it("hides tools a grant from before a scope was requested cannot call", async () => {
		const olderGrant = {
			...props,
			whopScope: adminGrantScope
				.split(" ")
				.filter((scope) => !scope.startsWith("ai_chat:"))
				.join(" "),
		};
		const names = await listToolNames(undefined, "/mcp", olderGrant);
		expect(names).not.toContain("ai-chats_list");
		expect(names).not.toContain("ai-chats_create");
		expect(names).toContain("payments_list");
	});

	it("keeps unscoped tools and diagnostics on a minimal grant", async () => {
		const names = await listToolNames(undefined, "/mcp", {
			...props,
			whopScope: "openid profile",
		});
		expect(names).toContain("connection_status");
		expect(names).toContain("docs_search");
		expect(names).not.toContain("payments_list");
	});
});
