import type { JsonSchema, OperationDef } from "../registry/types.ts";
import type { PrincipalContext } from "../policy/types.ts";
import type { BuiltinTool, ToolDefinition } from "./builtin-tool.ts";
import type { Dispatcher } from "./dispatcher.ts";
import { WhopMcpError } from "./errors.ts";

/**
 * ChatGPT-required meta-tools. Outside developer mode (and in deep research),
 * ChatGPT only calls `search` and `fetch`, so the hosted server exposes the
 * connected account's primary resources through them. Both are read-only and
 * route through the shared dispatcher — account binding, credential handling,
 * and redaction apply exactly as for every other tool.
 */

const SEARCH_SOURCES = [
	{
		toolName: "products_list",
		type: "product",
		titleFields: ["title", "name"],
	},
	{
		toolName: "variants_list",
		type: "variant",
		titleFields: ["title", "internal_notes"],
	},
	{ toolName: "payments_list", type: "payment", titleFields: ["id", "status"] },
	{
		toolName: "members_list",
		type: "member",
		titleFields: ["name", "username", "email"],
	},
] as const;

// Without a business, the API lists products and payments but not variants
// or members.
const SEARCH_TOOLS_WITHOUT_ACCOUNT = new Set([
	"products_list",
	"payments_list",
]);

const FETCH_SOURCES: Record<string, string> = {
	prod: "products_get",
	pass: "products_get",
	plan: "variants_get",
	pay: "payments_get",
	mem: "memberships_get",
	mber: "members_get",
	user: "users_get",
};

const QUERY_INPUT: JsonSchema = {
	type: "string",
	description: "Keywords to match.",
};

const SEARCH_TOOL: ToolDefinition = {
	name: "search",
	description:
		"Search a business's products, variants, payments, and members by keyword. Returns result IDs for use with fetch.",
	inputSchema: {
		type: "object",
		properties: {
			query: QUERY_INPUT,
			account_id: {
				type: "string",
				description:
					"Business to search (biz_). Without it, only marketplace products and your payments are searched.",
			},
		},
		required: ["query"],
		additionalProperties: false,
	},
	annotations: { readOnlyHint: true },
};

const SEARCH_TOOL_WITHOUT_ACCOUNT: ToolDefinition = {
	...SEARCH_TOOL,
	inputSchema: {
		...SEARCH_TOOL.inputSchema,
		properties: { query: QUERY_INPUT },
	},
};

const FETCH_TOOL: ToolDefinition = {
	name: "fetch",
	description:
		"Fetch the full record for one Whop resource ID returned by search (e.g. prod_…, plan_…, pay_…, mem_…).",
	inputSchema: {
		type: "object",
		properties: {
			id: { type: "string", description: "The resource ID to fetch." },
		},
		required: ["id"],
		additionalProperties: false,
	},
	annotations: { readOnlyHint: true },
};

interface SearchResult {
	id: string;
	title: string;
	url: string;
}

function findOperation(
	operations: OperationDef[],
	toolName: string,
): OperationDef | undefined {
	return operations.find((op) => op.toolName === toolName);
}

function rowsOf(body: unknown): Record<string, unknown>[] {
	if (body === null || typeof body !== "object") return [];
	const data = (body as { data?: unknown }).data;
	if (!Array.isArray(data)) return [];
	return data.filter(
		(row): row is Record<string, unknown> =>
			row !== null && typeof row === "object",
	);
}

function rowTitle(
	row: Record<string, unknown>,
	titleFields: readonly string[],
): string {
	for (const field of titleFields) {
		const value = row[field];
		if (typeof value === "string" && value) return value;
	}
	return String(row.id ?? "");
}

async function runSearch(
	query: string,
	accountId: string | null,
	visibleOps: OperationDef[],
	dispatcher: Dispatcher,
	principal: PrincipalContext,
): Promise<{ results: SearchResult[] }> {
	const needle = query.trim().toLowerCase();
	const pool = accountId
		? SEARCH_SOURCES
		: SEARCH_SOURCES.filter((source) =>
				SEARCH_TOOLS_WITHOUT_ACCOUNT.has(source.toolName),
			);
	const sources = pool
		.map((source) => ({
			source,
			operation: findOperation(visibleOps, source.toolName),
		}))
		.filter(
			(
				entry,
			): entry is {
				source: (typeof SEARCH_SOURCES)[number];
				operation: OperationDef;
			} => entry.operation !== undefined,
		);

	const settled = await Promise.allSettled(
		sources.map(({ operation }) =>
			dispatcher.dispatch(
				operation,
				accountId && operation.accountParam
					? { [operation.accountParam]: accountId }
					: {},
				principal,
			),
		),
	);

	const results: SearchResult[] = [];
	settled.forEach((outcome, index) => {
		if (outcome.status !== "fulfilled") return;
		const { source } = sources[index];
		for (const row of rowsOf(outcome.value.body)) {
			const id = typeof row.id === "string" ? row.id : null;
			if (!id) continue;
			const title = rowTitle(row, source.titleFields);
			const haystack = `${id} ${title}`.toLowerCase();
			if (needle && !haystack.includes(needle)) continue;
			results.push({
				id,
				title: `${title} (${source.type})`,
				url: `https://whop.com/dashboard`,
			});
		}
	});
	return { results: results.slice(0, 50) };
}

async function runFetch(
	id: string,
	visibleOps: OperationDef[],
	dispatcher: Dispatcher,
	principal: PrincipalContext,
): Promise<{ id: string; title: string; text: string; url: string } | null> {
	const prefix = id.split("_")[0];
	const toolName = FETCH_SOURCES[prefix];
	if (!toolName) return null;
	const operation = findOperation(visibleOps, toolName);
	if (!operation) return null;

	const result = await dispatcher.dispatch(operation, { id }, principal);
	return {
		id,
		title: id,
		text: JSON.stringify(result.body, null, 2),
		url: "https://whop.com/dashboard",
	};
}

/** How a route lists search or fetch in place of the defaults. */
export type CompatToolCopy = Pick<
	ToolDefinition,
	"name" | "description" | "annotations"
>;

export interface SearchToolOptions {
	/** Whether the tool takes an account_id to search inside one business. */
	takesAccount?: boolean;
	copy?: CompatToolCopy;
}

export function searchTool(
	visibleOps: OperationDef[],
	dispatcher: Dispatcher,
	principal: PrincipalContext,
	{ takesAccount = true, copy }: SearchToolOptions = {},
): BuiltinTool {
	return {
		definition: {
			...(takesAccount ? SEARCH_TOOL : SEARCH_TOOL_WITHOUT_ACCOUNT),
			...copy,
		},
		call: async (args) => {
			const query = typeof args.query === "string" ? args.query : "";
			const accountId =
				takesAccount && typeof args.account_id === "string"
					? args.account_id
					: principal.accountId;
			return JSON.stringify(
				await runSearch(query, accountId, visibleOps, dispatcher, principal),
				null,
				2,
			);
		},
	};
}

export function fetchTool(
	visibleOps: OperationDef[],
	dispatcher: Dispatcher,
	principal: PrincipalContext,
	copy?: CompatToolCopy,
): BuiltinTool {
	return {
		definition: { ...FETCH_TOOL, ...copy },
		call: async (args) => {
			const id = typeof args.id === "string" ? args.id : "";
			const fetched = await runFetch(id, visibleOps, dispatcher, principal);
			if (!fetched) {
				throw new WhopMcpError(
					"invalid_input",
					`No fetchable resource for id "${id}". Use an id returned by search.`,
				);
			}
			return JSON.stringify(fetched, null, 2);
		},
	};
}

export function chatGptTools(
	visibleOps: OperationDef[],
	dispatcher: Dispatcher,
	principal: PrincipalContext,
): BuiltinTool[] {
	return [
		searchTool(visibleOps, dispatcher, principal),
		fetchTool(visibleOps, dispatcher, principal),
	];
}
