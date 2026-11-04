import {
	type BuiltinTool,
	type ToolDefinition,
	validateToolArgs,
} from "./builtin-tool.ts";
import { redactText, WhopMcpError } from "./errors.ts";

const DOCS_MCP_URL = "https://docs.whop.com/mcp";
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_RESPONSE_CHARS = 512_000;
const MAX_RESULT_CHARS = 2_000;
const MAX_ERROR_CHARS = 500;
const UPSTREAM_NO_RESULTS = "No results found";
const UPSTREAM_BLOCKED_PATTERN = /\b403 Forbidden\b/;
const NO_RESULTS_MESSAGE =
	"No results found. Try different words, or omit version to search the current docs.";
const BLOCKED_MESSAGE =
	"Whop docs blocked this request because it looks like an attack, such as a system path or SQL injection. Rephrase it in plain words.";

export interface DocsOptions {
	fetch?: typeof fetch;
	timeoutMs?: number;
}

interface RpcResponse {
	result?: {
		content?: { type: string; text?: string }[];
		isError?: boolean;
	};
	error?: { message?: string };
}

const annotations = {
	readOnlyHint: true,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: true,
};

const SEARCH_TOOL: ToolDefinition = {
	name: "docs_search",
	description:
		"Search the Whop documentation at docs.whop.com: guides, API reference, webhooks, SDKs, and product help. Returns matching excerpts with page paths and links. Use it for how-to and concept questions, or to learn a field or endpoint before calling an operation tool. Read a full page with docs_query.",
	inputSchema: {
		type: "object",
		properties: {
			query: {
				type: "string",
				minLength: 1,
				maxLength: 1000,
				pattern: "\\S",
				description: "What to look for, in plain words.",
			},
			version: {
				type: "string",
				minLength: 1,
				maxLength: 50,
				pattern: "\\S",
				description:
					"Restrict results to one documentation version. Omit to search the current docs.",
			},
		},
		required: ["query"],
		additionalProperties: false,
	},
	annotations: { ...annotations, title: "Search Whop docs" },
};

const QUERY_TOOL: ToolDefinition = {
	name: "docs_query",
	description:
		"Run a read-only, shell-style command against a virtual filesystem that holds only the Whop documentation pages. It is not a shell on any real machine. Use ls or tree to explore, rg for exact matches, and head or cat to read a page that docs_search returned (append .mdx to its path). Example: head -100 /developer/guides/ai_and_mcp.mdx. Cite pages at https://docs.whop.com without the .mdx extension.",
	inputSchema: {
		type: "object",
		properties: {
			command: {
				type: "string",
				minLength: 1,
				maxLength: 1000,
				pattern: "\\S",
				description:
					'The command to run, for example `tree / -L 2`, `rg -il "webhook" /developer`, or `head -80 /payments/overview.mdx`.',
			},
		},
		required: ["command"],
		additionalProperties: false,
	},
	annotations: { ...annotations, title: "Read Whop docs" },
};

/**
 * Proxies to the Mintlify-hosted docs MCP server with one stateless JSON-RPC
 * `tools/call` per request. The upstream accepts calls without an
 * `initialize` handshake, so this skips the SDK client's extra round trip.
 */
export function docsTools(options: DocsOptions = {}): BuiltinTool[] {
	return [
		{
			definition: SEARCH_TOOL,
			instruction:
				"For how-to and concept questions, or to learn what a field or endpoint means, search the Whop docs with docs_search and read full pages with docs_query before guessing or calling ask_question.",
			call: async (args, signal) => {
				validateToolArgs(SEARCH_TOOL, args);
				const results = await callDocsMcp(
					"search_whop_docs",
					args,
					options,
					signal,
				);
				return bounded(results.map(trimResult));
			},
		},
		{
			definition: QUERY_TOOL,
			call: async (args, signal) => {
				validateToolArgs(QUERY_TOOL, args);
				return bounded(
					await callDocsMcp(
						"query_docs_filesystem_whop_docs",
						args,
						options,
						signal,
					),
				);
			},
		},
	];
}

function trimResult(text: string): string {
	if (text.length <= MAX_RESULT_CHARS) return text;
	const page = text.match(/^Page: (.+)$/m)?.[1]?.trim();
	return `${text.slice(0, MAX_RESULT_CHARS)}\n[Excerpt trimmed.${page ? ` Read the full page with docs_query: head -200 /${page}.mdx` : " Read the full page with docs_query."}]`;
}

function bounded(parts: string[]): string {
	const content = parts.join("\n\n");
	if (content.length <= MAX_RESPONSE_CHARS) return content;
	return `${content.slice(0, MAX_RESPONSE_CHARS)}\n\n[Truncated at ${MAX_RESPONSE_CHARS} characters. Narrow the search, or read one page with docs_query.]`;
}

async function callDocsMcp(
	name: string,
	args: Record<string, unknown>,
	options: DocsOptions,
	signal?: AbortSignal,
): Promise<string[]> {
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const timeout = AbortSignal.timeout(timeoutMs);

	let response: Response;
	let text: string;
	try {
		response = await (options.fetch ?? fetch)(DOCS_MCP_URL, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name, arguments: args },
			}),
			redirect: "manual",
			signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
		});
		text = await response.text();
	} catch (error) {
		if (timeout.aborted) {
			throw new WhopMcpError(
				"timeout",
				`Whop docs did not respond within ${timeoutMs}ms. Try again shortly.`,
			);
		}
		throw new WhopMcpError(
			"upstream_error",
			"Whop docs are unreachable right now. Try again shortly.",
			{ details: { cause: error instanceof Error ? error.name : "unknown" } },
		);
	}

	if (response.status === 429) {
		const retryAfter = response.headers.get("Retry-After");
		throw new WhopMcpError(
			"upstream_error",
			`Whop docs search is rate limited.${retryAfter ? ` Retry after ${retryAfter} seconds.` : " Try again later."} Rephrasing the request does not bypass the limit.`,
			{
				status: 429,
				...(retryAfter ? { details: { retry_after: retryAfter } } : {}),
			},
		);
	}
	if (!response.ok) {
		throw new WhopMcpError(
			"upstream_error",
			`Whop docs request failed with status ${response.status}.`,
			{ status: response.status },
		);
	}

	const message = parseRpcResponse(
		text,
		response.headers.get("Content-Type") ?? "",
	);
	if (message.error) {
		throw new WhopMcpError(
			"upstream_error",
			`Whop docs: ${errorText(message.error.message ?? "request failed")}`,
		);
	}
	const parts = (message.result?.content ?? []).flatMap((part) =>
		part.type === "text" && typeof part.text === "string" ? [part.text] : [],
	);
	if (message.result?.isError) {
		const text = parts.join("\n\n");
		if (text.trim() === UPSTREAM_NO_RESULTS) return [NO_RESULTS_MESSAGE];
		if (UPSTREAM_BLOCKED_PATTERN.test(text)) {
			throw new WhopMcpError("upstream_error", BLOCKED_MESSAGE, {
				status: 403,
			});
		}
		throw new WhopMcpError("upstream_error", `Whop docs: ${errorText(text)}`);
	}
	return parts;
}

function parseRpcResponse(text: string, contentType: string): RpcResponse {
	const payloads = contentType.includes("text/event-stream")
		? text.split(/\r?\n\r?\n/).map((event) =>
				event
					.split(/\r?\n/)
					.filter((line) => line.startsWith("data:"))
					.map((line) => line.slice(5).replace(/^ /, ""))
					.join("\n"),
			)
		: [text];
	for (const payload of payloads) {
		const message = parseJson(payload);
		if (message?.result || message?.error) return message;
	}
	throw new WhopMcpError(
		"upstream_error",
		"Whop docs returned a response that could not be read.",
	);
}

function parseJson(text: string): RpcResponse | undefined {
	if (!text) return undefined;
	try {
		return JSON.parse(text) as RpcResponse;
	} catch {
		return undefined;
	}
}

function errorText(text: string): string {
	const clean = redactText(text.trim());
	return clean.length > MAX_ERROR_CHARS
		? `${clean.slice(0, MAX_ERROR_CHARS)}…`
		: clean;
}
