import type { JsonSchema, OperationDef } from "../registry/types.ts";
import type { CalledAs } from "../safety/audit.ts";
import {
	type BuiltinTool,
	type ToolDefinition,
	validateToolArgs,
} from "./builtin-tool.ts";
import { WhopMcpError } from "./errors.ts";
import type { McpRequestContext } from "./mcp-context.ts";
import { calledAs, operationsByName, type ToolNaming } from "./tool-names.ts";

export const SEARCH_OPERATIONS_TOOL = "search_operations";
export const DESCRIBE_OPERATION_TOOL = "describe_operation";
export const CALL_READ_OPERATION_TOOL = "call_read_operation";
export const CALL_WRITE_OPERATION_TOOL = "call_write_operation";

export type OperationCallVia =
	| typeof CALL_READ_OPERATION_TOOL
	| typeof CALL_WRITE_OPERATION_TOOL;

/** How the client reached an operation, as its audit event records it. */
export interface OperationCall {
	calledAs: CalledAs;
	via?: OperationCallVia;
}

export type OperationExecutor = (
	operation: OperationDef,
	args: Record<string, unknown>,
	mcpRequestContext: McpRequestContext | undefined,
	call: OperationCall,
) => Promise<unknown>;

const DEFAULT_SEARCH_LIMIT = 10;
const MAX_SEARCH_LIMIT = 25;
const SCHEMAS_IN_SEARCH = 1;

const STOP_WORDS = new Set([
	"the",
	"an",
	"to",
	"of",
	"for",
	"in",
	"on",
	"my",
	"me",
	"our",
	"this",
	"that",
	"these",
	"are",
	"is",
	"what",
	"how",
	"do",
	"can",
	"all",
	"with",
	"from",
	"please",
]);

/**
 * Generic verbs. They never match an operation by themselves (every list_*
 * operation would), they only prefer the matching verb among operations the
 * rest of the query already matched.
 */
const VERBS: Record<string, string> = {
	list: "list",
	find: "list",
	search: "list",
	see: "list",
	show: "list",
	view: "list",
	who: "list",
	get: "get",
	check: "get",
	fetch: "get",
	create: "create",
	add: "create",
	new: "create",
	make: "create",
	send: "create",
	upload: "create",
	update: "update",
	edit: "update",
	change: "update",
	delete: "delete",
	remove: "delete",
};
const READ_VERBS = new Set(["list", "get"]);

const SYNONYMS: Record<string, string[]> = {
	sell: ["product", "variant", "checkout"],
	sale: ["payment"],
	revenue: ["payment", "stat", "ledger"],
	earning: ["payment", "stat", "ledger"],
	charge: ["payment"],
	order: ["payment"],
	transaction: ["payment", "ledger"],
	customer: ["member", "membership"],
	buyer: ["member", "membership"],
	subscriber: ["member", "membership"],
	subscription: ["membership"],
	access: ["membership"],
	price: ["variant", "plan"],
	pricing: ["variant", "plan"],
	plan: ["variant"],
	coupon: ["promo", "code"],
	discount: ["promo", "code"],
	clip: ["bounty"],
	clipping: ["bounty"],
	reward: ["bounty"],
	chargeback: ["dispute"],
	complaint: ["resolution", "case"],
	business: ["account"],
	company: ["account"],
	store: ["account", "product"],
	whop: ["product"],
	dm: ["dm", "channel", "message"],
	chat: ["message", "channel"],
	inbox: ["dm", "channel"],
	image: ["file"],
	video: ["file"],
	lesson: ["course"],
	metric: ["stat"],
	analytic: ["stat"],
	trend: ["stat", "series"],
	withdraw: ["payout"],
	cashout: ["payout"],
	webhook: ["webhook"],
};

const STOP_TOKENS = new Set([...STOP_WORDS].map(stem));
const VERB_TOKENS = new Map(
	Object.entries(VERBS).map(([word, verb]) => [stem(word), verb]),
);
const SYNONYM_TOKENS = new Map(
	Object.entries(SYNONYMS).map(([word, alternatives]) => [
		stem(word),
		alternatives.map(stem),
	]),
);

const FIELD_WEIGHTS = {
	name: 5,
	group: 4,
	summary: 3,
	path: 2,
} as const;

// Descriptions are not searched: an operation that only mentions a word in
// prose is not what the agent asked for.

type SearchField = keyof typeof FIELD_WEIGHTS;

interface IndexedOperation {
	operation: OperationDef;
	fields: Record<SearchField, Set<string>>;
	/** The operation's own verb, such as "list" for list_waitlist_entries. */
	verb: string;
	readOnly: boolean;
}

function stem(token: string): string {
	if (token.length > 4 && token.endsWith("ies"))
		return `${token.slice(0, -3)}y`;
	if (token.length > 3 && token.endsWith("s") && !token.endsWith("ss")) {
		return token.slice(0, -1);
	}
	return token;
}

function tokenize(text: string | undefined): string[] {
	if (!text) return [];
	return text
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((token) => token.length > 1)
		.map(stem);
}

function indexOperation(operation: OperationDef): IndexedOperation {
	return {
		operation,
		verb: tokenize(operation.verbName)[0] ?? "",
		readOnly: operation.annotations.readOnlyHint,
		fields: {
			name: new Set([
				...tokenize(operation.toolName),
				...tokenize(operation.verbName),
			]),
			group: new Set(tokenize(operation.group)),
			summary: new Set(tokenize(operation.summary)),
			path: new Set(tokenize(operation.path)),
		},
	};
}

/** The query's nouns with their synonyms; stop words and generic verbs drop out. */
export function expandQuery(query: string): string[][] {
	return tokenize(query)
		.filter((token) => !STOP_TOKENS.has(token) && !VERB_TOKENS.has(token))
		.map((token) => [token, ...(SYNONYM_TOKENS.get(token) ?? [])]);
}

function queryVerb(query: string): string | undefined {
	for (const token of tokenize(query)) {
		const verb = VERB_TOKENS.get(token);
		if (verb) return verb;
	}
}

/**
 * Prefers the operation whose verb the query used as typed ("send", "search",
 * "refund"), then one with its generic meaning ("list", "create"). Without
 * either, reads come first and list beats get.
 */
function verbPreference(
	entry: IndexedOperation,
	verb = "list",
	words: string[] = [],
): number {
	if (words.includes(entry.verb)) return 3;
	if (entry.verb === verb) return 2;
	return entry.readOnly === READ_VERBS.has(verb) ? 1 : 0;
}

/** Points for each query word, plus how many were typed rather than guessed. */
function score(entry: IndexedOperation, terms: string[][]) {
	let total = 0;
	let literal = 0;
	for (const [word, ...synonyms] of terms) {
		let best = 0;
		let typed = false;
		for (const [field, weight] of Object.entries(FIELD_WEIGHTS) as [
			SearchField,
			number,
		][]) {
			const tokens = entry.fields[field];
			if (word && tokens.has(word)) {
				best = Math.max(best, weight);
				typed = true;
			} else if (synonyms.some((term) => tokens.has(term))) {
				best = Math.max(best, weight);
			}
		}
		total += best;
		if (typed) literal += 1;
	}
	return { total, literal };
}

function operationSummary(operation: OperationDef, naming: ToolNaming) {
	return {
		name: naming.name(operation.toolName),
		summary: operation.summary ?? null,
		method: operation.method.toUpperCase(),
		path: operation.path,
		read_only: operation.annotations.readOnlyHint,
		destructive: operation.annotations.destructiveHint,
		call_with: operation.annotations.readOnlyHint
			? CALL_READ_OPERATION_TOOL
			: CALL_WRITE_OPERATION_TOOL,
	};
}

function operationDetail(
	operation: OperationDef,
	inputSchema: JsonSchema,
	naming: ToolNaming,
) {
	return {
		...operationSummary(operation, naming),
		description:
			operation.description === undefined
				? null
				: naming.inText(operation.description),
		input_schema: inputSchema,
	};
}

function nameProperty(naming: ToolNaming): JsonSchema {
	return {
		type: "string",
		minLength: 1,
		maxLength: 200,
		pattern: "\\S",
		description: `The operation name, exactly as search_operations returned it (for example ${naming.name("payouts_list")}).`,
	};
}

function searchDescription(operationCount: number, readOnly: boolean): string {
	if (readOnly) {
		return `The listed Whop tools cover only the most common tasks. This searches every other Whop read this connection can run (${operationCount} in total), such as payouts, invoices, affiliates, ads, apps, analytics, courses and forums. Call it before telling the user that Whop can't show something or that no tool exists. Describe what you want to see in plain words, for example "list my payouts". Returns matches with the full input schema for the best match only (describe_operation returns it for the others); run one with ${CALL_READ_OPERATION_TOOL}.`;
	}
	return `The listed Whop tools cover only the most common tasks. This searches every other Whop operation this connection can run (${operationCount} in total), such as payouts, invoices, affiliates, ads, apps, analytics, courses and forums. Call it before telling the user that Whop can't do something or that no tool exists. Describe the task in plain words, for example "create a promo code". Returns matches with the full input schema for the best match only (describe_operation returns it for the others); run one with ${CALL_READ_OPERATION_TOOL} or ${CALL_WRITE_OPERATION_TOOL}.`;
}

const SEARCH_DEFINITION: ToolDefinition = {
	name: SEARCH_OPERATIONS_TOOL,
	description: searchDescription(0, false),
	inputSchema: {
		type: "object",
		properties: {
			query: {
				type: "string",
				minLength: 1,
				maxLength: 500,
				pattern: "\\S",
				description: "The task in plain words.",
			},
			limit: {
				type: "integer",
				minimum: 1,
				maximum: MAX_SEARCH_LIMIT,
				description: `How many matches to return. Defaults to ${DEFAULT_SEARCH_LIMIT}.`,
			},
		},
		required: ["query"],
		additionalProperties: false,
	},
	annotations: {
		title: "Search Whop operations",
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: false,
	},
};

function describeDefinition(naming: ToolNaming): ToolDefinition {
	return {
		name: DESCRIBE_OPERATION_TOOL,
		description:
			"Returns one Whop operation's description, input schema and safety hints, including fields that listed tools leave out. Use it before calling an operation whose inputs you have not seen.",
		inputSchema: {
			type: "object",
			properties: { name: nameProperty(naming) },
			required: ["name"],
			additionalProperties: false,
		},
		annotations: {
			title: "Describe a Whop operation",
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
	};
}

function callDefinition(
	via: OperationCallVia,
	naming: ToolNaming,
): ToolDefinition {
	const write = via === CALL_WRITE_OPERATION_TOOL;
	const properties: Record<string, JsonSchema> = {
		name: nameProperty(naming),
		arguments: {
			type: "object",
			description:
				"The operation's input, matching the input schema from search_operations or describe_operation. Omit it when the operation takes no input.",
		},
	};
	if (write) {
		properties.idempotency_key = {
			type: "string",
			description:
				"Caller-chosen stable retry key. Reuse the same key when retrying after a timeout or error, then verify the outcome.",
		};
	}
	return {
		name: via,
		description: write
			? "Runs a Whop operation that creates, changes or deletes something, found with search_operations. Only accepts operations whose read_only is false."
			: "Runs a read-only Whop operation found with search_operations. Only accepts operations whose read_only is true.",
		inputSchema: {
			type: "object",
			properties,
			required: ["name"],
			additionalProperties: false,
		},
		annotations: write
			? {
					title: "Run a Whop write operation",
					readOnlyHint: false,
					destructiveHint: true,
					idempotentHint: false,
					openWorldHint: false,
				}
			: {
					title: "Run a Whop read operation",
					readOnlyHint: true,
					destructiveHint: false,
					idempotentHint: true,
					openWorldHint: false,
				},
	};
}

export function operationTools(
	visibleOperations: OperationDef[],
	execute: OperationExecutor,
	inputSchemaFor: (operation: OperationDef) => JsonSchema,
	{ readOnly, naming }: { readOnly: boolean; naming: ToolNaming },
): BuiltinTool[] {
	const searchable = readOnly
		? visibleOperations.filter((op) => op.annotations.readOnlyHint)
		: visibleOperations;
	const searchDefinition: ToolDefinition = {
		...SEARCH_DEFINITION,
		description: searchDescription(searchable.length, readOnly),
	};
	const describe = describeDefinition(naming);
	const index = searchable.map(indexOperation);
	const byName = operationsByName(visibleOperations);

	function lookup(name: string): OperationDef {
		const operation = byName.get(name);
		if (!operation) {
			throw new WhopMcpError(
				"tool_not_found",
				`Unknown operation "${name}" for this connection's profile and scopes. Find one with ${SEARCH_OPERATIONS_TOOL}.`,
			);
		}
		return operation;
	}

	function callTool(via: OperationCallVia): BuiltinTool {
		const definition = callDefinition(via, naming);
		const write = via === CALL_WRITE_OPERATION_TOOL;
		return {
			definition,
			asksForIntent: true,
			call: async (args, _signal, mcpRequestContext) => {
				validateToolArgs(definition, args);
				const name = args.name as string;
				const operation = lookup(name);
				if (operation.annotations.readOnlyHint === write) {
					const other = write
						? CALL_READ_OPERATION_TOOL
						: CALL_WRITE_OPERATION_TOOL;
					throw new WhopMcpError(
						"invalid_input",
						`${operation.toolName} is ${write ? "read-only" : "a write"}; call it with ${other}.`,
					);
				}
				const {
					name: _name,
					arguments: operationArgs,
					...callOptions
				} = args as Record<string, unknown> & {
					arguments?: Record<string, unknown>;
				};
				const result = await execute(
					operation,
					{ ...operationArgs, ...callOptions },
					mcpRequestContext && {
						...mcpRequestContext,
						toolName: operation.toolName,
					},
					{ calledAs: calledAs(operation, name), via },
				);
				return JSON.stringify(result, null, 2);
			},
		};
	}

	return [
		{
			definition: searchDefinition,
			instruction: readOnly
				? `The listed tools are only the most-used Whop operations; ${searchable.length} more reads are available. Before telling the user Whop can't show something or that no tool exists, call ${SEARCH_OPERATIONS_TOOL} with what you want to see in plain words, then run the match with ${CALL_READ_OPERATION_TOOL}. This connection cannot run writes that are not listed.`
				: `The listed tools are only the most-used Whop operations; ${searchable.length} are available in total. Before telling the user a Whop task isn't possible or that no tool exists, call ${SEARCH_OPERATIONS_TOOL} with the task in plain words, then run the match with ${CALL_READ_OPERATION_TOOL} or ${CALL_WRITE_OPERATION_TOOL}. Look up Whop operations and docs with these tools instead of answering from memory.`,
			call: async (args) => {
				validateToolArgs(searchDefinition, args);
				const terms = expandQuery(args.query as string);
				const limit = Math.min(
					Math.max(
						(args.limit as number | undefined) ?? DEFAULT_SEARCH_LIMIT,
						1,
					),
					MAX_SEARCH_LIMIT,
				);
				const verb = queryVerb(args.query as string);
				const words = tokenize(args.query as string).filter(
					(token) => !STOP_TOKENS.has(token),
				);
				const matches = index
					.map((entry) => ({ entry, ...score(entry, terms) }))
					.filter((match) => match.total > 0)
					.sort(
						(a, b) =>
							b.total - a.total ||
							verbPreference(b.entry, verb, words) -
								verbPreference(a.entry, verb, words) ||
							b.literal - a.literal ||
							a.entry.fields.name.size - b.entry.fields.name.size ||
							(a.entry.operation.toolName < b.entry.operation.toolName
								? -1
								: 1),
					)
					.slice(0, limit)
					.map(({ entry }, rank) =>
						rank < SCHEMAS_IN_SEARCH
							? operationDetail(
									entry.operation,
									inputSchemaFor(entry.operation),
									naming,
								)
							: operationSummary(entry.operation, naming),
					);
				return JSON.stringify(
					matches.length
						? { operations: matches }
						: {
								operations: [],
								message:
									'No operation matches that. Rephrase with the thing you want (for example "payouts" or "promo codes"), or use docs_search to check whether Whop supports it.',
							},
					null,
					2,
				);
			},
		},
		{
			definition: describe,
			call: async (args) => {
				validateToolArgs(describe, args);
				const operation = lookup(args.name as string);
				return JSON.stringify(
					operationDetail(operation, inputSchemaFor(operation), naming),
					null,
					2,
				);
			},
		},
		callTool(CALL_READ_OPERATION_TOOL),
		...(readOnly ? [] : [callTool(CALL_WRITE_OPERATION_TOOL)]),
	];
}
