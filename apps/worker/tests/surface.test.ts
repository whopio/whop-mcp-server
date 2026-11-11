import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

const { createMcpApiHandler } = await import("../src/mcp-handler.ts");
import type { SurfaceName } from "@whop/mcp-server";
import {
	expandMuseToWhopScopes,
	expandProfileToWhopScopes,
} from "../src/profile-scopes.ts";
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

const METADATA = "https://mcp.whop.test/.well-known/oauth-protected-resource";

function post(
	surface: SurfaceName | undefined,
	path: string,
	method: string,
	params?: Record<string, unknown>,
	grant: WhopGrantProps = props,
): Promise<Response> {
	return createMcpApiHandler(surface).fetch(
		new Request(`https://mcp.whop.test${path}`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
			},
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
		}),
		env,
		{ props: grant } as unknown as ExecutionContext,
	);
}

function listTools(
	surface: SurfaceName | undefined,
	path: string,
	grant?: WhopGrantProps,
): Promise<Response> {
	return post(surface, path, "tools/list", undefined, grant);
}

async function rpc(
	surface: SurfaceName | undefined,
	path: string,
	method: string,
	params?: Record<string, unknown>,
	grant?: WhopGrantProps,
): Promise<Record<string, unknown>> {
	const response = await post(surface, path, method, params, grant);
	expect(response.status).toBe(200);
	const body = (await response.json()) as { result: Record<string, unknown> };
	return body.result;
}

async function listToolNames(
	surface: SurfaceName | undefined,
	path: string,
	grant?: WhopGrantProps,
): Promise<string[]> {
	const result = (await rpc(surface, path, "tools/list", undefined, grant)) as {
		tools: { name: string }[];
	};
	return result.tools.map((tool) => tool.name);
}

async function describeOperation(
	surface: SurfaceName | undefined,
	path: string,
	name: string,
	grant?: WhopGrantProps,
): Promise<{ isError?: boolean; text: string }> {
	const result = (await rpc(
		surface,
		path,
		"tools/call",
		{ name: "describe_operation", arguments: { name } },
		grant,
	)) as { isError?: boolean; content: { text: string }[] };
	return { isError: result.isError, text: result.content[0]?.text ?? "" };
}

describe("per-route tool surfaces", () => {
	it("lists core tools and the operation tools on /mcp", async () => {
		const names = await listToolNames(undefined, "/mcp");
		expect(names).toContain("payments_list");
		expect(names).toContain("search_operations");
		expect(names).toContain("call_write_operation");
		expect(names).not.toContain("media_generate");
	});

	it("keeps unlisted operations reachable on /mcp", async () => {
		const media = await describeOperation(undefined, "/mcp", "media_generate");
		expect(media.isError).toBeFalsy();
		const transfers = await describeOperation(
			undefined,
			"/mcp",
			"transfers_create",
		);
		expect(transfers.isError).toBeFalsy();
	});

	it("drops media generation and money-out tools on /claude/mcp", async () => {
		const names = await listToolNames("claude_directory", "/claude/mcp");
		expect(names).toContain("payments_refund");
		expect(names).toContain("connection_status");
		for (const name of [
			"media_generate",
			"transfers_create",
			"payouts_create",
		]) {
			expect(names).not.toContain(name);
			const result = await describeOperation(
				"claude_directory",
				"/claude/mcp",
				name,
			);
			expect(result.isError).toBe(true);
			expect(result.text).toContain("tool_not_found");
		}
	});

	it("serves /mcp's core tools without money movement to a Muse grant", async () => {
		const muse = {
			...props,
			profile: "muse",
			whopScope: expandMuseToWhopScopes(registry.operations).join(" "),
		};
		const names = await listToolNames("muse", "/muse/mcp", muse);
		const full = await listToolNames(undefined, "/mcp");
		expect(names).toContain("payments_list");
		expect(names).toContain("docs_search");
		expect(names).toContain("connection_status");
		expect(names).toContain("search_operations");
		expect(names).toContain("call_read_operation");
		for (const name of [
			"payments_refund",
			"call_write_operation",
			"report_feedback",
			"ask_question",
			"search",
			"fetch",
		]) {
			expect(names).not.toContain(name);
		}
		const operationNames = new Set(
			registry.operations.map((op) => op.toolName),
		);
		expect(names.filter((name) => operationNames.has(name))).toEqual(
			full.filter(
				(name) => operationNames.has(name) && name !== "payments_refund",
			),
		);
		const result = (await rpc(
			"muse",
			"/muse/mcp",
			"tools/call",
			{ name: "transfers_create", arguments: {} },
			muse,
		)) as { isError?: boolean; content: { text: string }[] };
		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain("tool_not_found");
	});

	it("rejects a full-scope grant on /muse/mcp", async () => {
		const response = await listTools("muse", "/muse/mcp");
		expect(response.status).toBe(403);
		expect(response.headers.get("WWW-Authenticate")).toContain(
			'error="insufficient_scope"',
		);
		expect(response.headers.get("WWW-Authenticate")).toContain(
			"/.well-known/oauth-protected-resource/muse/mcp",
		);
	});

	it("points an expired Muse grant at the route's own discovery document", async () => {
		const response = await listTools("muse", "/muse/mcp", {
			...props,
			profile: "muse",
			whopExpiresAt: 0,
		});
		expect(response.status).toBe(401);
		expect(response.headers.get("WWW-Authenticate")).toContain(
			'resource_metadata="https://mcp.whop.test/.well-known/oauth-protected-resource/muse/mcp"',
		);
	});

	it("keeps the root discovery document on an expired /mcp grant", async () => {
		const response = await listTools(undefined, "/mcp", {
			...props,
			whopExpiresAt: 0,
		});
		expect(response.status).toBe(401);
		expect(response.headers.get("WWW-Authenticate")).toContain(
			'resource_metadata="https://mcp.whop.test/.well-known/oauth-protected-resource"',
		);
	});

	it("hides tools whose scopes the token was never granted", async () => {
		for (const name of ["ad-pixels_list", "automations_list"]) {
			const result = await describeOperation(undefined, "/mcp", name);
			expect(result.text).toContain("tool_not_found");
		}
		const aiChats = await describeOperation(undefined, "/mcp", "ai-chats_list");
		expect(aiChats.isError).toBeFalsy();
	});

	it("hides tools a grant from before a scope was requested cannot call", async () => {
		const olderGrant = {
			...props,
			whopScope: adminGrantScope
				.split(" ")
				.filter((scope) => !scope.startsWith("ai_chat:"))
				.join(" "),
		};
		for (const name of ["ai-chats_list", "ai-chats_create"]) {
			const result = await describeOperation(
				undefined,
				"/mcp",
				name,
				olderGrant,
			);
			expect(result.text).toContain("tool_not_found");
		}
		const names = await listToolNames(undefined, "/mcp", olderGrant);
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

	it("serves the ChatGPT list on /chatgpt/mcp to a ChatGPT grant", async () => {
		const names = await listToolNames("chatgpt", "/chatgpt/mcp", {
			...props,
			profile: "chatgpt",
		});
		for (const name of [
			"media_generate",
			"domains_create",
			"accounts_form_company",
			"ad-campaigns_create",
			"exports_create",
			"connection_status",
			"docs_search",
			"search",
			"fetch",
		]) {
			expect(names).toContain(name);
		}
		for (const name of [
			"payments_refund",
			"invoices_charge",
			"transfers_create",
			"ads_report-stats",
			"ads_report-issues",
		]) {
			expect(names).not.toContain(name);
		}
	});

	it("rejects a full-scope grant on /chatgpt/mcp", async () => {
		const response = await listTools("chatgpt", "/chatgpt/mcp");
		expect(response.status).toBe(403);
		expect(response.headers.get("WWW-Authenticate")).toContain(
			'error="insufficient_scope"',
		);
		expect(response.headers.get("WWW-Authenticate")).toContain(
			`resource_metadata="${METADATA}/chatgpt/mcp"`,
		);
	});

	it("points a grant with no credential at the route's discovery document", async () => {
		const response = await listTools(
			"chatgpt",
			"/chatgpt/mcp",
			{} as WhopGrantProps,
		);
		expect(response.status).toBe(401);
		expect(response.headers.get("WWW-Authenticate")).toContain(
			`resource_metadata="${METADATA}/chatgpt/mcp"`,
		);
	});

	it("points a grant with no credential at the route's discovery document", async () => {
		const response = await listTools(
			"chatgpt",
			"/chatgpt/mcp",
			{} as WhopGrantProps,
		);
		expect(response.status).toBe(401);
		expect(response.headers.get("WWW-Authenticate")).toContain(
			`resource_metadata="${METADATA}/chatgpt/mcp"`,
		);
	});

	it("points expired grants at each route's discovery document", async () => {
		const expired = { ...props, whopExpiresAt: 0 };
		const header = async (
			surface: SurfaceName | undefined,
			path: string,
			grant: WhopGrantProps,
		) => {
			const response = await listTools(surface, path, grant);
			expect(response.status).toBe(401);
			return response.headers.get("WWW-Authenticate");
		};
		expect(await header(undefined, "/mcp", expired)).toContain(
			`resource_metadata="${METADATA}"`,
		);
		expect(await header("claude_directory", "/claude/mcp", expired)).toContain(
			`resource_metadata="${METADATA}"`,
		);
		expect(
			await header("chatgpt", "/chatgpt/mcp", {
				...expired,
				profile: "chatgpt",
			}),
		).toContain(`resource_metadata="${METADATA}/chatgpt/mcp"`);
	});
});
