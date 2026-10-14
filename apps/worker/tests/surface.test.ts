import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

const { createMcpApiHandler } = await import("../src/mcp-handler.ts");
import type { SurfaceName } from "@whop/mcp-server";
import type { Env, WhopGrantProps } from "../src/types.ts";

const props: WhopGrantProps = {
	consentVersion: 1,
	whopScope: "openid profile",
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
	MCP_CONFIRMATION_SECRET: "test-confirmation-secret-long-enough",
	CF_VERSION_METADATA: { id: "test-version" },
} as Env;

async function listToolNames(
	surface: SurfaceName | undefined,
	path: string,
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
		{ props } as unknown as ExecutionContext,
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
});
