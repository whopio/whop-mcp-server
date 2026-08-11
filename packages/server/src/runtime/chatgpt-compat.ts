import type { OperationDef } from "../registry/types.ts";
import type { PrincipalContext } from "../policy/types.ts";
import type { Dispatcher } from "./dispatcher.ts";

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
		toolName: "plans_list",
		type: "plan",
		titleFields: ["title", "internal_notes"],
	},
	{ toolName: "payments_list", type: "payment", titleFields: ["id", "status"] },
	{
		toolName: "members_list",
		type: "member",
		titleFields: ["name", "username", "email"],
	},
] as const;

const FETCH_SOURCES: Record<string, string> = {
	prod: "products_get",
	pass: "products_get",
	plan: "plans_get",
	pay: "payments_get",
	mem: "memberships_get",
	mber: "members_get",
	user: "users_get",
};

export const SEARCH_TOOL = {
	name: "search",
	description:
		"Search the connected Whop account's products, plans, payments, and members by keyword. Returns result IDs for use with fetch.",
	inputSchema: {
		type: "object",
		properties: {
			query: { type: "string", description: "Keywords to match." },
		},
		required: ["query"],
		additionalProperties: false,
	},
	annotations: { readOnlyHint: true },
};

export const FETCH_TOOL = {
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

export async function runSearch(
	query: string,
	visibleOps: OperationDef[],
	dispatcher: Dispatcher,
	principal: PrincipalContext,
): Promise<{ results: SearchResult[] }> {
	const needle = query.trim().toLowerCase();
	const sources = SEARCH_SOURCES.map((source) => ({
		source,
		operation: findOperation(visibleOps, source.toolName),
	})).filter(
		(
			entry,
		): entry is {
			source: (typeof SEARCH_SOURCES)[number];
			operation: OperationDef;
		} => entry.operation !== undefined,
	);

	const settled = await Promise.allSettled(
		sources.map(({ operation }) =>
			dispatcher.dispatch(operation, {}, principal),
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

export async function runFetch(
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
