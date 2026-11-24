import {
	CHATGPT_API_KEY_OBJECTS,
	CHATGPT_DESTRUCTIVE_WRITES,
	CHATGPT_HIDDEN_OUTPUTS,
	CHATGPT_OPEN_WORLD_WRITES,
	CHATGPT_REMOVED_INPUTS,
	CHATGPT_RESTRICTED_FIELDS,
	CHATGPT_TOOLS,
} from "../policy/chatgpt.ts";
import { operationKey } from "../policy/surfaces.ts";
import type { PrincipalContext } from "../policy/types.ts";
import type {
	JsonSchema,
	OperationDef,
	ToolAnnotations,
} from "../registry/types.ts";
import {
	type BuiltinTool,
	type ToolDefinition,
	validateToolArgs,
} from "./builtin-tool.ts";
import { fetchTool, searchTool } from "./chatgpt-compat.ts";
import type { Dispatcher } from "./dispatcher.ts";
import { type DocsOptions, docsSearchTool } from "./docs.ts";
import { WhopMcpError } from "./errors.ts";

const COMPANY_FORMATION_PAGE = "https://whop.com/form-company";

// Write tools act on the first call, and OpenAI wants a person to confirm
// irreversible actions. The tools flagged confirmationRequired say so here, and
// the instructions cover the rest.
const CONSEQUENTIAL_DESCRIPTION =
	"This tool acts on the first call. Tell the user what will happen and get their explicit yes before calling it.";

// OpenAI says to keep the most important details in the first 512 characters,
// so confirmation and unavailable actions come right after the header.
export const CHATGPT_INSTRUCTIONS = [
	"Consequential tools (anything that costs money, goes live, affects other people, or can't be undone) act on the first call, so never call one just to see a preview. Tell the user what will happen, get their explicit yes, then call it.",
	"This connection cannot issue refunds, charge saved cards, create invoices or send payouts: say so, offer no workaround. Tell the user they can do it in their Whop dashboard.",
	"Do not volunteer customers' email addresses, phone numbers, postal addresses, IP addresses or card or bank details. Include one when the user asks for it or needs it to tell two customers apart.",
] as const;

export const CHATGPT_BUILTINS = {
	search: {
		name: "search",
		description:
			"Matches a keyword against the newest public Whop marketplace listings and, by payment ID or status, recent payments across the signed-in person's businesses. Use this when someone needs the ID of a marketplace product or a recent payment. It takes no business, so it cannot look inside one business.",
	},
	fetch: {
		name: "fetch",
		description:
			"Gets the full record for one Whop ID, such as a product, variant, payment, membership, member or user. Use this when someone has a record's ID and needs its details.",
	},
	connection_status: {
		name: "get_connection_status",
		description:
			"Returns details of this connection: who is signed in, the selected business, the permission level and the tools available. Use this when someone asks which login or business is connected, or why something is unavailable. It never returns credentials.",
	},
	docs_search: {
		name: "search_docs",
		description:
			"Searches the Whop documentation at docs.whop.com, including guides, reference pages and product help, and returns matching excerpts with links. Use this when someone asks how something on Whop works or how to do it.",
	},
	company_formation: {
		name: "get_company_formation_link",
		description:
			"Returns the link to Whop's company formation page for a business, where the person enters their own details to form an LLC or C-Corp. Use this when someone wants to form a company for their business. It collects no personal data and files nothing itself.",
	},
} as const;

const COMPAT_ANNOTATIONS: ToolDefinition["annotations"] = {
	readOnlyHint: true,
	destructiveHint: false,
	openWorldHint: true,
};

export const CHATGPT_BUILTIN_NAMES: readonly string[] = Object.values(
	CHATGPT_BUILTINS,
).map((tool) => tool.name);

export function chatgptAnnotations(operation: OperationDef): ToolAnnotations {
	const key = operationKey(operation);
	return {
		readOnlyHint: operation.annotations.readOnlyHint,
		destructiveHint:
			operation.annotations.destructiveHint ||
			CHATGPT_DESTRUCTIVE_WRITES.has(key),
		idempotentHint: operation.annotations.idempotentHint,
		openWorldHint:
			operation.annotations.openWorldHint || CHATGPT_OPEN_WORLD_WRITES.has(key),
	};
}

function withoutRestrictedProperties(schema: JsonSchema): JsonSchema {
	const stripped: JsonSchema = { ...schema };
	if (schema.properties) {
		stripped.properties = Object.fromEntries(
			Object.entries(schema.properties)
				.filter(([name]) => !CHATGPT_RESTRICTED_FIELDS.has(name))
				.map(([name, property]) => [
					name,
					withoutRestrictedProperties(property),
				]),
		);
	}
	if (schema.required) {
		stripped.required = schema.required.filter(
			(name) => !CHATGPT_RESTRICTED_FIELDS.has(name),
		);
	}
	if (schema.items) stripped.items = withoutRestrictedProperties(schema.items);
	if (
		typeof schema.additionalProperties === "object" &&
		schema.additionalProperties !== null
	) {
		stripped.additionalProperties = withoutRestrictedProperties(
			schema.additionalProperties,
		);
	}
	for (const union of ["oneOf", "anyOf", "allOf"] as const) {
		const variants = schema[union];
		if (variants) stripped[union] = variants.map(withoutRestrictedProperties);
	}
	return stripped;
}

function withoutInput(schema: JsonSchema, path: readonly string[]): JsonSchema {
	const [name, ...rest] = path;
	const property = schema.properties?.[name];
	if (!property) return schema;
	const properties = { ...schema.properties };
	if (rest.length > 0) {
		properties[name] = withoutInput(property, rest);
		return { ...schema, properties };
	}
	delete properties[name];
	return {
		...schema,
		properties,
		...(schema.required
			? { required: schema.required.filter((entry) => entry !== name) }
			: {}),
	};
}

function stripRemovedInputs(schema: JsonSchema, key: string): JsonSchema {
	return (CHATGPT_REMOVED_INPUTS[key] ?? []).reduce(
		(current, removed) => withoutInput(current, removed.path),
		withoutRestrictedProperties(schema),
	);
}

/**
 * Operations as served on the ChatGPT route: with ChatGPT descriptions and
 * hints, and without removed inputs. They keep their registry names for audits
 * and attribution and are listed under their verb names like on /mcp.
 */
export function chatgptOperations(operations: OperationDef[]): OperationDef[] {
	return operations.flatMap((operation) => {
		const key = operationKey(operation);
		const description = CHATGPT_TOOLS[key];
		if (!description) return [];
		return [
			{
				...operation,
				description: operation.safety.confirmationRequired
					? `${description}\n\n${CONSEQUENTIAL_DESCRIPTION}`
					: description,
				inputSchema: stripRemovedInputs(operation.inputSchema, key),
				...(operation.bodySchema
					? { bodySchema: stripRemovedInputs(operation.bodySchema, key) }
					: {}),
				annotations: chatgptAnnotations(operation),
			},
		];
	});
}

function restrictedFieldsIn(value: unknown, found: Set<string>): Set<string> {
	if (Array.isArray(value)) {
		for (const item of value) restrictedFieldsIn(item, found);
	} else if (value !== null && typeof value === "object") {
		for (const [key, entry] of Object.entries(value)) {
			if (CHATGPT_RESTRICTED_FIELDS.has(key)) found.add(key);
			else restrictedFieldsIn(entry, found);
		}
	}
	return found;
}

function sends(args: unknown, path: readonly string[]): boolean {
	let value = args;
	for (const name of path) {
		if (
			value === null ||
			typeof value !== "object" ||
			!Object.hasOwn(value, name)
		) {
			return false;
		}
		value = (value as Record<string, unknown>)[name];
	}
	return true;
}

export function rejectRemovedInputs(
	operation: OperationDef,
	args: Record<string, unknown>,
): void {
	const fields = [...restrictedFieldsIn(args, new Set())].sort();
	if (fields.length > 0) {
		throw new WhopMcpError(
			"invalid_input",
			`${operation.toolName} does not take ${fields.join(", ")} on this connection, so nothing was sent. Call it again without ${fields.length > 1 ? "those fields" : "that field"}. The user can enter the information themselves on whop.com.`,
		);
	}
	for (const removed of CHATGPT_REMOVED_INPUTS[operationKey(operation)] ?? []) {
		if (sends(args, removed.path)) {
			throw new WhopMcpError(
				"invalid_input",
				`${operation.toolName} does not take ${removed.path.join(".")} on this connection, so nothing was sent. Call it again without that field. ${removed.instead}`,
			);
		}
	}
}

function hiddenInResults(key: string, parent: string | undefined): boolean {
	return (
		CHATGPT_RESTRICTED_FIELDS.has(key) ||
		CHATGPT_HIDDEN_OUTPUTS.has(key) ||
		(key === "token" &&
			parent !== undefined &&
			CHATGPT_API_KEY_OBJECTS.has(parent))
	);
}

function withoutHidden(value: unknown, parent: string | undefined): unknown {
	if (Array.isArray(value)) {
		return value.map((item) => withoutHidden(item, parent));
	}
	if (value === null || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value)
			.filter(([key]) => !hiddenInResults(key, parent))
			.map(([key, entry]) => [key, withoutHidden(entry, key)]),
	);
}

export function withoutHiddenFields(body: unknown): unknown {
	return withoutHidden(body, undefined);
}

function companyFormationLinkTool(principal: PrincipalContext): BuiltinTool {
	const definition: ToolDefinition = {
		name: CHATGPT_BUILTINS.company_formation.name,
		description: CHATGPT_BUILTINS.company_formation.description,
		inputSchema: {
			type: "object",
			properties: {
				account_id: {
					type: "string",
					pattern: "^biz_[A-Za-z0-9]+$",
					description: "The business to form a company for, as its biz_ ID.",
				},
			},
			required: ["account_id"],
			additionalProperties: false,
		},
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
	};
	return {
		definition,
		call: async (args) => {
			validateToolArgs(definition, args);
			const accountId = args.account_id as string;
			if (principal.accountId && principal.accountId !== accountId) {
				throw new WhopMcpError(
					"account_mismatch",
					`This connection is bound to account ${principal.accountId}; input "account_id" references ${accountId}.`,
				);
			}
			return JSON.stringify(
				{
					url: `${COMPANY_FORMATION_PAGE}/${accountId}`,
					message:
						"The person completes company formation themselves on Whop at this link; nothing was filed or submitted from here.",
				},
				null,
				2,
			);
		},
	};
}

function connectionStatusTool(
	principal: PrincipalContext,
	operations: OperationDef[],
	listedToolCount: () => number,
): BuiltinTool {
	const byGroup: Record<string, number> = {};
	for (const op of operations) {
		byGroup[op.group] = (byGroup[op.group] ?? 0) + 1;
	}
	return {
		definition: {
			name: CHATGPT_BUILTINS.connection_status.name,
			description: CHATGPT_BUILTINS.connection_status.description,
			inputSchema: {
				type: "object",
				properties: {},
				additionalProperties: false,
			},
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				openWorldHint: false,
			},
		},
		call: async () =>
			JSON.stringify(
				{
					user_name: principal.userName ?? null,
					account_id: principal.accountId,
					account_title: principal.accountTitle ?? null,
					permission_profile: principal.permissionProfile,
					tool_count: listedToolCount(),
					tool_categories: byGroup,
				},
				null,
				2,
			),
	};
}

export interface ChatgptBuiltinsOptions {
	operations: OperationDef[];
	dispatcher: Dispatcher;
	principal: PrincipalContext;
	chatGptCompat?: boolean;
	docs?: DocsOptions;
}

export function chatgptBuiltins({
	operations,
	dispatcher,
	principal,
	chatGptCompat,
	docs,
}: ChatgptBuiltinsOptions): BuiltinTool[] {
	const compat = chatGptCompat
		? [
				searchTool(operations, dispatcher, principal, {
					takesAccount: false,
					copy: { ...CHATGPT_BUILTINS.search, annotations: COMPAT_ANNOTATIONS },
				}),
				fetchTool(operations, dispatcher, principal, {
					...CHATGPT_BUILTINS.fetch,
					annotations: COMPAT_ANNOTATIONS,
				}),
			]
		: [];
	const docsSearch = docs
		? [
				docsSearchTool({
					...docs,
					copy: CHATGPT_BUILTINS.docs_search,
					withDocsQuery: false,
				}),
			]
		: [];
	const builtins: BuiltinTool[] = [
		...compat,
		connectionStatusTool(
			principal,
			operations,
			() => operations.length + builtins.length,
		),
		...docsSearch,
		companyFormationLinkTool(principal),
	];
	return builtins;
}
