import type { ListToolsResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import {
	createStreamableHttpHandler,
	HttpAuthError,
} from "../src/adapters/streamable-http.ts";
import { docsTools } from "../src/runtime/docs.ts";
import type { ProfileName } from "../src/policy/profiles.ts";
import type { SurfaceName } from "../src/policy/surfaces.ts";
import {
	buildRealRegistry,
	principalFixture,
	staticCredential,
} from "./helpers.ts";

type FetchArgs = Parameters<typeof fetch>;

const registry = buildRealRegistry();

interface ToolResponse {
	result: { isError?: boolean; content: { text: string }[] };
}

function sse(message: unknown): Response {
	return new Response(`event: message\ndata: ${JSON.stringify(message)}\n\n`, {
		headers: { "Content-Type": "text/event-stream" },
	});
}

function textResult(text: string, isError = false) {
	return {
		jsonrpc: "2.0",
		id: 1,
		result: {
			content: [{ type: "text", text }],
			...(isError ? { isError } : {}),
		},
	};
}

function docsFetch(text = "Title: Webhooks") {
	return vi.fn(async (..._args: FetchArgs) => sse(textResult(text)));
}

function handler(
	options: {
		docs?: boolean;
		fetch?: typeof fetch;
		surface?: SurfaceName;
		profile?: ProfileName;
	} = {},
) {
	return createStreamableHttpHandler({
		registry,
		confirmationSecret: "test-confirmation-secret-long-enough",
		docs: options.docs ?? true,
		fetch: options.fetch,
		surface: options.surface,
		authenticator: {
			async authenticate(request) {
				if (request.headers.get("Authorization") !== "Bearer test-token") {
					throw new HttpAuthError(401, "Authentication required");
				}
				return {
					principal: principalFixture({
						permissionProfile: options.profile ?? "admin",
					}),
					credentialAdapter: staticCredential(),
				};
			},
		},
	});
}

function request(method: string, params: Record<string, unknown> = {}) {
	return new Request("https://mcp.whop.test/mcp", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
			Authorization: "Bearer test-token",
		},
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
	});
}

async function listTools(options?: Parameters<typeof handler>[0]) {
	const response = await handler(options)(request("tools/list"));
	const { result } = (await response.json()) as { result: ListToolsResult };
	return result.tools;
}

async function callTool(
	name: string,
	args: Record<string, unknown>,
	options?: Parameters<typeof handler>[0],
) {
	const response = await handler(options)(
		request("tools/call", { name, arguments: args }),
	);
	return ((await response.json()) as ToolResponse).result;
}

function search(fetch: typeof globalThis.fetch, timeoutMs?: number) {
	return docsTools({ fetch, timeoutMs })[0];
}

function query(fetch: typeof globalThis.fetch) {
	return docsTools({ fetch })[1];
}

describe("docs tools over authenticated HTTP", () => {
	it("advertises both read-only tools only when docs are enabled", async () => {
		const withDocs = await listTools();
		for (const name of ["docs_search", "docs_query"]) {
			const tool = withDocs.find((tool) => tool.name === name);
			expect(tool?.annotations).toMatchObject({
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			});
			expect(tool?.inputSchema.properties).not.toHaveProperty("intent");
		}
		const withoutDocs = await listTools({ docs: false });
		expect(withoutDocs.map((tool) => tool.name)).not.toContain("docs_search");
		expect(withoutDocs.map((tool) => tool.name)).not.toContain("docs_query");
	});

	it.each([
		{ surface: "claude_directory" as const, profile: "admin" as const },
		{ surface: "full" as const, profile: "read_only" as const },
	])(
		"keeps docs tools on the $surface surface with the $profile profile",
		async (options) => {
			const names = (await listTools(options)).map((tool) => tool.name);
			expect(names).toContain("docs_search");
			expect(names).toContain("docs_query");
		},
	);

	it("forwards a search without the user's credential", async () => {
		const fetch = docsFetch();
		const result = await callTool(
			"docs_search",
			{ query: "webhook retries", version: "v1" },
			{ fetch },
		);
		expect(result.isError).not.toBe(true);
		expect(result.content[0].text).toBe("Title: Webhooks");
		const [url, init] = fetch.mock.calls[0];
		expect(url).toBe("https://docs.whop.com/mcp");
		expect(init).toMatchObject({ method: "POST", redirect: "manual" });
		expect(init?.headers).not.toHaveProperty("Authorization");
		expect(JSON.parse(init?.body as string)).toEqual({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: {
				name: "search_whop_docs",
				arguments: { query: "webhook retries", version: "v1" },
			},
		});
	});

	it("maps a filesystem command to the upstream filesystem tool", async () => {
		const fetch = docsFetch("exit: 0");
		const result = await callTool(
			"docs_query",
			{ command: "tree / -L 1" },
			{ fetch },
		);
		expect(result.content[0].text).toBe("exit: 0");
		expect(JSON.parse(fetch.mock.calls[0][1]?.body as string).params).toEqual({
			name: "query_docs_filesystem_whop_docs",
			arguments: { command: "tree / -L 1" },
		});
	});

	it.each([
		["a missing query", "docs_search", {}],
		["a blank query", "docs_search", { query: "   " }],
		["a blank version", "docs_search", { query: "ok", version: " " }],
		["an overlong query", "docs_search", { query: "x".repeat(1001) }],
		["an unknown field", "docs_search", { query: "ok", extra: true }],
		["a non-string command", "docs_query", { command: 42 }],
	])("rejects %s without calling upstream", async (_label, name, args) => {
		const fetch = docsFetch();
		const result = await callTool(name, args, { fetch });
		expect(result.isError).toBe(true);
		expect(JSON.parse(result.content[0].text).error.code).toBe("invalid_input");
		expect(fetch).not.toHaveBeenCalled();
	});

	it("reports the docs tools as unknown when docs are disabled", async () => {
		const result = await callTool(
			"docs_search",
			{ query: "x" },
			{ docs: false },
		);
		expect(result.isError).toBe(true);
		expect(JSON.parse(result.content[0].text).error.code).toBe(
			"tool_not_found",
		);
	});
});

describe("docs upstream", () => {
	it("joins text parts and drops other content", async () => {
		const fetch = vi.fn(async () =>
			sse({
				jsonrpc: "2.0",
				id: 1,
				result: {
					content: [
						{ type: "text", text: "first" },
						{ type: "image", data: "ignored" },
						{ type: "text", text: "second" },
					],
				},
			}),
		);
		await expect(search(fetch).call({ query: "webhooks" })).resolves.toBe(
			"first\n\nsecond",
		);
	});

	it("reports a 429 with the Retry-After hint", async () => {
		const fetch = vi.fn(
			async () =>
				new Response("slow down", {
					status: 429,
					headers: { "Retry-After": "30" },
				}),
		);
		const error = await search(fetch)
			.call({ query: "refunds" })
			.catch((e: unknown) => e);
		expect(error).toMatchObject({
			code: "upstream_error",
			status: 429,
			details: { retry_after: "30" },
		});
		expect(String(error)).toContain("Retry after 30 seconds");
	});

	it.each([302, 500, 503])(
		"rejects an unsuccessful status (%s)",
		async (status) => {
			const fetch = vi.fn(async () => new Response("failure", { status }));
			await expect(search(fetch).call({ query: "x" })).rejects.toMatchObject({
				code: "upstream_error",
				status,
			});
		},
	);

	it("surfaces an upstream tool error without leaking credentials", async () => {
		const fetch = vi.fn(async () =>
			sse(textResult("bad request Bearer abc.def.ghi", true)),
		);
		const error = await query(fetch)
			.call({ command: "ls" })
			.catch((e: unknown) => e);
		expect(error).toMatchObject({ code: "upstream_error" });
		expect(String(error)).toContain("Bearer [redacted]");
		expect(String(error)).not.toContain("abc.def.ghi");
	});

	it("surfaces a JSON-RPC error", async () => {
		const fetch = vi.fn(async () =>
			Response.json({
				jsonrpc: "2.0",
				id: 1,
				error: { code: -32602, message: "Unknown tool" },
			}),
		);
		await expect(search(fetch).call({ query: "x" })).rejects.toMatchObject({
			code: "upstream_error",
			message: "Whop docs: Unknown tool",
		});
	});

	it("rejects an unreadable body", async () => {
		const fetch = vi.fn(
			async () =>
				new Response("event: message\ndata: {not json\n\n", {
					headers: { "Content-Type": "text/event-stream" },
				}),
		);
		await expect(search(fetch).call({ query: "x" })).rejects.toMatchObject({
			code: "upstream_error",
			message: "Whop docs returned a response that could not be read.",
		});
	});

	it("trims each long search result to an excerpt that points at the full page", async () => {
		const long = `Title: Create Webhook\nPage: api-reference/webhooks/create-webhook\nContent: ${"x".repeat(3_000)}`;
		const short =
			"Title: Delivery\nPage: developer/guides/webhooks\nContent: retries";
		const fetch = vi.fn(async () =>
			sse({
				jsonrpc: "2.0",
				id: 1,
				result: {
					content: [
						{ type: "text", text: long },
						{ type: "text", text: short },
					],
				},
			}),
		);
		const [first, second] = (
			await search(fetch).call({ query: "webhooks" })
		).split("\n\n");
		expect(first).toBe(
			`${long.slice(0, 2_000)}\n[Excerpt trimmed. Read the full page with docs_query: head -200 /api-reference/webhooks/create-webhook.mdx]`,
		);
		expect(second).toBe(short);
	});

	it("never trims a page read through docs_query", async () => {
		const page = "y".repeat(5_000);
		await expect(
			query(docsFetch(page)).call({ command: "cat /page.mdx" }),
		).resolves.toBe(page);
	});

	it("truncates an oversized response with a hint", async () => {
		const text = await query(docsFetch("z".repeat(600_000))).call({
			command: "cat /huge.mdx",
		});
		expect(text).toContain("[Truncated at 512000 characters.");
		expect(text.length).toBeLessThan(513_000);
	});

	it("forwards the caller's abort signal", async () => {
		const controller = new AbortController();
		const stopped = new Error("stopped");
		const fetch = vi.fn(
			(...[, init]: FetchArgs) =>
				new Promise<Response>((_, reject) => {
					init?.signal?.addEventListener("abort", () =>
						reject(init.signal?.reason),
					);
				}),
		);
		const pending = search(fetch).call({ query: "x" }, controller.signal);
		controller.abort(stopped);
		await expect(pending).rejects.toMatchObject({
			code: "upstream_error",
			details: { cause: "Error" },
		});
	});

	it("reports a timeout distinctly from a network failure", async () => {
		const hang = vi.fn(
			(...[, init]: FetchArgs) =>
				new Promise<Response>((_, reject) => {
					init?.signal?.addEventListener("abort", () =>
						reject(new DOMException("aborted", "AbortError")),
					);
				}),
		);
		await expect(search(hang, 5).call({ query: "x" })).rejects.toMatchObject({
			code: "timeout",
		});

		const fail = vi.fn(async () => {
			throw new TypeError("fetch failed");
		});
		await expect(search(fail).call({ query: "x" })).rejects.toMatchObject({
			code: "upstream_error",
			details: { cause: "TypeError" },
		});
	});
});
