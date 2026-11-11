import type { JsonSchema, OperationDef } from "../registry/types.ts";
import {
	type BuiltinTool,
	type ToolDefinition,
	validateToolArgs,
} from "./builtin-tool.ts";
import { WhopMcpError } from "./errors.ts";

export const SEARCH_OPERATIONS_TOOL = "search_operations";
export const DESCRIBE_OPERATION_TOOL = "describe_operation";
export const CALL_READ_OPERATION_TOOL = "call_read_operation";
export const CALL_WRITE_OPERATION_TOOL = "call_write_operation";

export type OperationCallVia =
	| typeof CALL_READ_OPERATION_TOOL
	| typeof CALL_WRITE_OPERATION_TOOL;

export type OperationExecutor = (
	operation: OperationDef,
	args: Record<string, unknown>,
	via: OperationCallVia,
) => Promise<unknown>;

const DEFAULT_SEARCH_LIMIT = 10;
const MAX_SEARCH_LIMIT = 25;
const SCHEMAS_IN_SEARCH = 3;

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

const SYNONYMS: Record<string, string[]> = {
	find: ["list", "search"],
	see: ["list", "get"],
	show: ["list", "get"],
	view: ["list", "get"],
	check: ["get", "list"],
	who: ["list"],
	add: ["create"],
	new: ["create"],
	make: ["create"],
	send: ["create"],
	remove: ["delete"],
	edit: ["update"],
	change: ["update"],
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
	upload: ["file"],
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
	description: 1,
} as const;

type SearchField = keyof typeof FIELD_WEIGHTS;

interface IndexedOperation {
	operation: OperationDef;
	fields: Record<SearchField, Set<string>>;
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
		fields: {
			name: new Set(tokenize(operation.toolName)),
			group: new Set(tokenize(operation.group)),
			summary: new Set(tokenize(operation.summary)),
			path: new Set(tokenize(operation.path)),
			description: new Set(tokenize(operation.description)),
		},
	};
}

export function expandQuery(query: string): string[][] {
	return tokenize(query)
		.filter((token) => !STOP_TOKENS.has(token))
		.map((token) => [token, ...(SYNONYM_TOKENS.get(token) ?? [])]);
}

function score(entry: IndexedOperation, terms: string[][]): number {
	let total = 0;
	for (const alternatives of terms) {
		let best = 0;
		for (const [field, weight] of Object.entries(FIELD_WEIGHTS) as [
			SearchField,
			number,
		][]) {
			if (alternatives.some((term) => entry.fields[field].has(term))) {
				best = Math.max(best, weight);
			}
		}
		total += best;
	}
	return total;
}

function operationSummary(operation: OperationDef) {
	return {
		name: operation.toolName,
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

function operationDetail(operation: OperationDef, inputSchema: JsonSchema) {
	return {
		...operationSummary(operation),
		description: operation.description ?? null,
		input_schema: inputSchema,
	};
}

const NAME_PROPERTY: JsonSchema = {
	type: "string",
	minLength: 1,
	maxLength: 200,
	pattern: "\\S",
	description:
		"The operation name, exactly as search_operations returned it (for example payouts_list).",
};

function searchDescription(operationCount: number, readOnly: boolean): string {
	if (readOnly) {
		return `The listed Whop tools cover only the most common tasks. This searches every other Whop read this connection can run (${operationCount} in total), such as payouts, invoices, affiliates, ads, apps, analytics, courses and forums. Call it before telling the user that Whop can't show something or that no tool exists. Describe what you want to see in plain words, for example "list my payouts". Returns matches with the full input schema for the top 3; run one with ${CALL_READ_OPERATION_TOOL}.`;
	}
	return `The listed Whop tools cover only the most common tasks. This searches every other Whop operation this connection can run (${operationCount} in total), such as webhooks, payouts, invoices, affiliates, ads, apps, analytics, courses and forums. Call it before telling the user that Whop can't do something or that no tool exists. Describe the task in plain words, for example "list my webhooks" or "create a promo code". Returns matches with the full input schema for the top 3; run one with ${CALL_READ_OPERATION_TOOL} or ${CALL_WRITE_OPERATION_TOOL}.`;
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

const DESCRIBE_DEFINITION: ToolDefinition = {
	name: DESCRIBE_OPERATION_TOOL,
	description:
		"Returns one Whop operation's description, input schema and safety hints, including fields that listed tools leave out. Use it before calling an operation whose inputs you have not seen.",
	inputSchema: {
		type: "object",
		properties: { name: NAME_PROPERTY },
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

function callDefinition(
	via: OperationCallVia,
	withIntentContext: (schema: JsonSchema) => JsonSchema,
): ToolDefinition {
	const write = via === CALL_WRITE_OPERATION_TOOL;
	const properties: Record<string, JsonSchema> = {
		name: NAME_PROPERTY,
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
		inputSchema: withIntentContext({
			type: "object",
			properties,
			required: ["name"],
			additionalProperties: false,
		}) as ToolDefinition["inputSchema"],
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
	withIntentContext: (schema: JsonSchema) => JsonSchema,
	inputSchemaFor: (operation: OperationDef) => JsonSchema,
	options: { readOnly?: boolean } = {},
): BuiltinTool[] {
	const readOnly = options.readOnly ?? false;
	const searchable = readOnly
		? visibleOperations.filter((op) => op.annotations.readOnlyHint)
		: visibleOperations;
	const searchDefinition: ToolDefinition = {
		...SEARCH_DEFINITION,
		description: searchDescription(searchable.length, readOnly),
	};
	const index = searchable.map(indexOperation);
	const byName = new Map(visibleOperations.map((op) => [op.toolName, op]));

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
		const definition = callDefinition(via, withIntentContext);
		const write = via === CALL_WRITE_OPERATION_TOOL;
		return {
			definition,
			call: async (args) => {
				validateToolArgs(definition, args);
				const operation = lookup(args.name as string);
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
					...context
				} = args as Record<string, unknown> & {
					arguments?: Record<string, unknown>;
				};
				const result = await execute(
					operation,
					{ ...operationArgs, ...context },
					via,
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
				const matches = index
					.map((entry) => ({ entry, score: score(entry, terms) }))
					.filter((match) => match.score > 0)
					.sort(
						(a, b) =>
							b.score - a.score ||
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
								)
							: operationSummary(entry.operation),
					);
				return JSON.stringify(
					matches.length
						? { operations: matches }
						: {
								operations: [],
								message:
									"No operations matched. Try other words, or describe the result you want.",
							},
					null,
					2,
				);
			},
		},
		{
			definition: DESCRIBE_DEFINITION,
			call: async (args) => {
				validateToolArgs(DESCRIBE_DEFINITION, args);
				const operation = lookup(args.name as string);
				return JSON.stringify(
					operationDetail(operation, inputSchemaFor(operation)),
					null,
					2,
				);
			},
		},
		callTool(CALL_READ_OPERATION_TOOL),
		...(readOnly ? [] : [callTool(CALL_WRITE_OPERATION_TOOL)]),
	];
}
