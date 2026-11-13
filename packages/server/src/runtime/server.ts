import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type {
	JsonSchema,
	OperationDef,
	RegistryManifest,
} from "../registry/types.ts";
import type { CredentialAdapter, PrincipalContext } from "../policy/types.ts";
import {
	auditEvent,
	InMemoryAuditSink,
	type AuditSink,
} from "../safety/audit.ts";
import {
	CHATGPT_DESTRUCTIVE_WRITES,
	CHATGPT_OPEN_WORLD_WRITES,
	CHATGPT_SIDE_EFFECT_READS,
	DEFAULT_SURFACE,
	type SurfaceName,
} from "../policy/surfaces.ts";
import { visibleOperations } from "../policy/visibility.ts";
import { Dispatcher } from "./dispatcher.ts";
import { WhopMcpError } from "./errors.ts";
import type { BuiltinTool, ToolDefinition } from "./builtin-tool.ts";
import { chatGptTools } from "./chatgpt-compat.ts";
import type { McpRequestContext } from "./mcp-context.ts";
import { docsTools } from "./docs.ts";
import { feedbackTools, type FeedbackSink } from "./feedback.ts";
import { type OperationCallVia, operationTools } from "./operation-tools.ts";

export const SERVER_NAME = "whop";
export const SERVER_VERSION = "0.0.1";
export const DEFAULT_BASE_URL = "https://api.whop.com/api/v1";
export const SERVER_ICONS = [
	{
		src: "https://whop.com/apple-icon.png",
		mimeType: "image/png",
		sizes: ["512x512"],
	},
];

const IDEMPOTENCY_KEY_FIELD = "idempotency_key";
const INTENT_FIELD = "intent";
const INTENT_ID_FIELD = "intent_id";
const UUID_PATTERN =
	"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$";
const UUID_REGEX = new RegExp(UUID_PATTERN);
const LISTED_SCHEMA_OMIT_DESCRIPTION =
	"Some optional inputs are left out of this listing to keep it small. Call describe_operation to see every input; all of them are accepted.";

export type ToolListing = "full" | "compact";

const CONNECTION_STATUS_TOOL: ToolDefinition = {
	name: "connection_status",
	description:
		"Returns safe diagnostics for this connection: authenticated identity, selected account, permission profile, scopes, tool coverage, and build metadata. Never returns credentials.",
	inputSchema: {
		type: "object",
		properties: {},
		additionalProperties: false,
	},
	annotations: { readOnlyHint: true },
};

// OpenAI requires all three hints on every tool, and these built-ins set only
// readOnlyHint. The older routes keep what they have.
const CHATGPT_BUILTIN_HINTS: Record<
	string,
	{ destructiveHint: boolean; openWorldHint: boolean }
> = {
	search: { destructiveHint: false, openWorldHint: true },
	fetch: { destructiveHint: false, openWorldHint: true },
	connection_status: { destructiveHint: false, openWorldHint: false },
};

// A signed-in user on this route isn't bound to one business, and search takes
// no account, so it can't reach what the shared text promises.
const CHATGPT_SEARCH_DESCRIPTION =
	"Matches a keyword against the newest public Whop marketplace listings and, by payment ID or status, the most recent sales across every business the signed-in user can read. It takes no business, so it can't narrow to one business or see its products, variants or members. For those, call products_list, variants_list or members_list with account_id, or search_list to look up one account's records. Returns result IDs for use with fetch.";

const CHATGPT_CONNECTION_STATUS_DESCRIPTION =
	"Shows who is signed in, the selected account, the permission profile, and how many tools are available. Never returns credentials.";

function listedBuiltin(
	definition: ToolDefinition,
	surface: SurfaceName | undefined,
): ToolDefinition {
	if (surface !== "chatgpt") return definition;
	const hints = CHATGPT_BUILTIN_HINTS[definition.name];
	return {
		...definition,
		...(definition.name === "search"
			? { description: CHATGPT_SEARCH_DESCRIPTION }
			: {}),
		...(definition.name === "connection_status"
			? { description: CHATGPT_CONNECTION_STATUS_DESCRIPTION }
			: {}),
		...(hints ? { annotations: { ...definition.annotations, ...hints } } : {}),
	};
}

export interface CreateWhopMcpServerOptions {
	registry: RegistryManifest;
	credentialAdapter: CredentialAdapter;
	principal: PrincipalContext;
	auditSink?: AuditSink;
	feedbackSink?: FeedbackSink;
	/** Expose docs_search and docs_query. */
	docs?: boolean;
	fetch?: typeof fetch;
	baseUrl?: string;
	timeoutMs?: number;
	maxResponseBytes?: number;
	clientName?: string;
	pluginSource?: string;
	/** Restrict to the native REST surface (full surface by default). */
	nativeOnly?: boolean;
	/** The fixed tool subset this endpoint serves (see policy/surfaces.ts). */
	surface?: SurfaceName;
	/**
	 * "compact" lists only core operations plus the operation tools
	 * (search_operations, describe_operation, call_read_operation,
	 * call_write_operation) that reach the rest. Every visible operation stays
	 * callable by name either way. Defaults to "full".
	 */
	toolListing?: ToolListing;
	/** Extra headers stamped on every upstream request (attribution). */
	extraHeaders?: Record<string, string>;
	/**
	 * Policy hook invoked immediately before an operation executes. Throw a
	 * WhopMcpError to block the call.
	 */
	beforeCall?: (
		operation: OperationDef,
		args: Record<string, unknown>,
		principal: PrincipalContext,
	) => Promise<void>;
	/**
	 * Expose the ChatGPT-required `search` and `fetch` meta-tools. Hosted
	 * deployments enable this; outside developer mode ChatGPT calls only
	 * these two tools.
	 */
	chatGptCompat?: boolean;
}

export interface WhopMcpServer {
	server: Server;
	operations: OperationDef[];
}

function withIntentContext(inputSchema: JsonSchema): JsonSchema {
	return {
		...inputSchema,
		properties: {
			...inputSchema.properties,
			[INTENT_FIELD]: {
				type: "string",
				minLength: 1,
				pattern: "\\S",
				description:
					"The original user request that led to this tool call. Copy it verbatim when available.",
			},
			[INTENT_ID_FIELD]: {
				type: "string",
				format: "uuid",
				minLength: 36,
				maxLength: 36,
				pattern: UUID_PATTERN,
				description:
					"A UUID for the user turn that caused this call. Generate it once per user message and reuse it for every tool call made to fulfill that message. Never derive it from the intent text.",
			},
		},
		required: [
			...new Set([
				...(inputSchema.required ?? []),
				INTENT_FIELD,
				INTENT_ID_FIELD,
			]),
		],
	};
}

function withAccountRequirement(
	operation: OperationDef,
	principal: PrincipalContext,
): JsonSchema {
	const { inputSchema, accountParam } = operation;
	if (!accountParam || !operation.requiresAccount || principal.accountId) {
		return inputSchema;
	}
	return {
		...inputSchema,
		required: [
			...new Set([...(inputSchema.required ?? []), accountParam]),
		].sort(),
	};
}

function toolInputSchema(
	operation: OperationDef,
	principal: PrincipalContext,
): JsonSchema {
	const inputSchema = withAccountRequirement(operation, principal);
	const offersIdempotencyKey =
		operation.safety.confirmationRequired ||
		operation.safety.idempotency !== "none";
	if (!offersIdempotencyKey) return inputSchema;

	return {
		...inputSchema,
		properties: {
			...inputSchema.properties,
			[IDEMPOTENCY_KEY_FIELD]: {
				type: "string",
				description: supportsUpstreamReplay(operation)
					? "Caller-chosen stable retry key. Reuse the same key when retrying after a timeout or error. The native API replays completed requests and rejects requests still in flight."
					: "Caller-chosen stable key forwarded to the API. Reuse the same key when retrying, but verify the operation outcome after an ambiguous error.",
			},
		},
	};
}

function listedInputSchema(
	operation: OperationDef,
	principal: PrincipalContext,
): JsonSchema {
	const schema = toolInputSchema(operation, principal);
	const hidden = hiddenListedProperties(operation, schema);
	if (hidden.size === 0) return schema;
	return {
		...schema,
		properties: Object.fromEntries(
			Object.entries(schema.properties ?? {}).filter(
				([name]) => !hidden.has(name),
			),
		),
		additionalProperties: true,
	};
}

function hiddenListedProperties(
	operation: OperationDef,
	schema: JsonSchema,
): Set<string> {
	if (operation.listedSchemaOnly) {
		const shown = new Set([
			...operation.listedSchemaOnly,
			...(schema.required ?? []),
			IDEMPOTENCY_KEY_FIELD,
		]);
		return new Set(
			Object.keys(schema.properties ?? {}).filter((name) => !shown.has(name)),
		);
	}
	return new Set(operation.listedSchemaOmit ?? []);
}

function listedToolDescription(
	operation: OperationDef,
	surface: SurfaceName | undefined,
): string {
	const description = toolDescription(operation, surface);
	return operation.listedSchemaOmit || operation.listedSchemaOnly
		? `${description}\n\n${LISTED_SCHEMA_OMIT_DESCRIPTION}`
		: description;
}

// Write tools act on the first call, and OpenAI wants a person to confirm
// irreversible actions. The tools flagged confirmationRequired say so here, and
// the instructions cover the rest.
const CHATGPT_CONSEQUENTIAL_DESCRIPTION =
	"This tool acts on the first call. Tell the user what will happen and get their explicit yes before calling it.";

function toolDescription(
	operation: OperationDef,
	surface: SurfaceName | undefined,
): string {
	const description = operation.description || operation.summary || "";
	if (surface !== "chatgpt" || !operation.safety.confirmationRequired) {
		return description;
	}
	return [description, CHATGPT_CONSEQUENTIAL_DESCRIPTION]
		.filter(Boolean)
		.join("\n\n");
}

function onChatgptList(
	operation: OperationDef,
	surface: SurfaceName | undefined,
	writes: ReadonlySet<string>,
): boolean {
	return (
		surface === "chatgpt" &&
		writes.has(`${operation.method.toUpperCase()} ${operation.path}`)
	);
}

function jsonContent(value: unknown): {
	content: { type: "text"; text: string }[];
	isError?: boolean;
} {
	return {
		content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
	};
}

function errorContentFor(
	error: WhopMcpError,
	surface: SurfaceName | undefined,
): {
	content: { type: "text"; text: string }[];
	isError: boolean;
} {
	const result = error.toResult() as { error: Record<string, unknown> };
	// OpenAI's response rule names request IDs. The audit event keeps this one.
	if (surface === "chatgpt") delete result.error.request_id;
	return {
		content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
		isError: true,
	};
}

// The first call of most conversations doesn't need tax IDs, and accounts_get
// still returns them.
function withoutTaxIdentifiers(body: unknown): unknown {
	const rows = (body as { data?: unknown } | null)?.data;
	if (!Array.isArray(rows)) return body;
	return {
		...(body as Record<string, unknown>),
		data: rows.map((row: unknown) => {
			if (row === null || typeof row !== "object") return row;
			const copy = { ...(row as Record<string, unknown>) };
			delete copy.tax_identifiers;
			return copy;
		}),
	};
}

export function createWhopMcpServer(
	options: CreateWhopMcpServerOptions,
): WhopMcpServer {
	const { registry, principal } = options;
	const errorContent = (error: WhopMcpError) =>
		errorContentFor(error, options.surface);
	const operations = visibleOperations(registry, principal, {
		nativeOnly: options.nativeOnly,
		surface: options.surface,
	});
	const byName = new Map(operations.map((op) => [op.toolName, op]));
	const compact = options.toolListing === "compact";
	// Muse approves each tool and bars collecting more data than a tool needs,
	// so its route offers only read-only operation tools and no intent fields.
	const reviewedToolsOnly = options.surface === "muse";
	// OpenAI allows a brief, task-specific intent field only when it improves
	// execution. This one is attribution only, so ChatGPT skips it too.
	const collectsIntent = !reviewedToolsOnly && options.surface !== "chatgpt";
	const intentSchema = (schema: JsonSchema) =>
		collectsIntent ? withIntentContext(schema) : schema;
	const listedOperations = compact
		? operations
				.filter((op) => op.core)
				.sort((a, b) => (a.core ?? 0) - (b.core ?? 0))
		: operations;

	const auditSink = options.auditSink ?? new InMemoryAuditSink();
	const dispatcher = new Dispatcher({
		baseUrl: options.baseUrl ?? DEFAULT_BASE_URL,
		apiVersionDate: registry.meta.apiVersionDate,
		credentialAdapter: options.credentialAdapter,
		fetch: options.fetch,
		timeoutMs: options.timeoutMs,
		maxResponseBytes: options.maxResponseBytes,
		userAgent: `whop-mcp/${SERVER_VERSION}`,
		extraHeaders: options.extraHeaders,
	});

	const builtins: BuiltinTool[] = [
		...(options.chatGptCompat
			? chatGptTools(operations, dispatcher, principal, options.surface)
			: []),
		...(options.feedbackSink
			? feedbackTools(options.feedbackSink, principal, {
					clientName: options.clientName,
					pluginSource: options.pluginSource,
				})
			: []),
		...(options.docs
			? docsTools({ fetch: options.fetch, timeoutMs: options.timeoutMs })
			: []),
		...(compact
			? operationTools(
					operations,
					executeOperation,
					intentSchema,
					(operation) => withAccountRequirement(operation, principal),
					{ readOnly: reviewedToolsOnly },
				)
			: []),
		{
			definition: CONNECTION_STATUS_TOOL,
			call: async () =>
				JSON.stringify(
					connectionStatus(
						registry,
						principal,
						operations,
						listedOperations,
						options.surface ?? DEFAULT_SURFACE,
					),
					null,
					2,
				),
		},
	];
	const builtinByName = new Map(
		builtins.map((tool) => [tool.definition.name, tool]),
	);

	const server = new Server(
		{ name: SERVER_NAME, version: SERVER_VERSION, icons: SERVER_ICONS },
		{
			capabilities: { tools: {} },
			instructions: buildInstructions(
				principal,
				options.surface,
				operations,
				listedOperations,
				builtins,
				collectsIntent,
			),
		},
	);

	server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: [
			...listedOperations.map((op) => ({
				name: op.toolName,
				description: compact
					? listedToolDescription(op, options.surface)
					: toolDescription(op, options.surface),
				inputSchema: intentSchema(
					compact
						? listedInputSchema(op, principal)
						: toolInputSchema(op, principal),
				) as Record<string, unknown>,
				annotations: {
					readOnlyHint:
						op.annotations.readOnlyHint &&
						!onChatgptList(op, options.surface, CHATGPT_SIDE_EFFECT_READS),
					destructiveHint:
						op.annotations.destructiveHint ||
						onChatgptList(op, options.surface, CHATGPT_DESTRUCTIVE_WRITES),
					idempotentHint:
						op.annotations.idempotentHint &&
						!onChatgptList(op, options.surface, CHATGPT_SIDE_EFFECT_READS),
					openWorldHint:
						op.annotations.openWorldHint ||
						onChatgptList(op, options.surface, CHATGPT_OPEN_WORLD_WRITES),
					title: op.summary,
				},
			})),
			...builtins.map((tool) =>
				listedBuiltin(tool.definition, options.surface),
			),
		],
	}));

	server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
		const { name, arguments: rawArgs = {} } = request.params;
		const builtin = builtinByName.get(name);
		if (builtin) {
			try {
				return {
					content: [
						{
							type: "text" as const,
							text: await builtin.call(rawArgs, extra.signal),
						},
					],
				};
			} catch (error) {
				return errorContent(
					error instanceof WhopMcpError
						? error
						: new WhopMcpError("internal_error", `${name} failed.`),
				);
			}
		}

		const operation = byName.get(name);
		if (!operation) {
			return errorContent(
				new WhopMcpError(
					"tool_not_found",
					`Unknown tool "${name}" for this connection's profile and scopes.`,
				),
			);
		}
		try {
			return jsonContent(await executeOperation(operation, rawArgs));
		} catch (error) {
			return errorContent(
				error instanceof WhopMcpError
					? error
					: new WhopMcpError("internal_error", "Unexpected server error."),
			);
		}
	});

	async function executeOperation(
		operation: OperationDef,
		rawArgs: Record<string, unknown>,
		via?: OperationCallVia,
	): Promise<unknown> {
		const intentContext = collectsIntent
			? parseIntentContext(operation.toolName, rawArgs)
			: { arguments: rawArgs, context: undefined };
		if (intentContext instanceof WhopMcpError) throw intentContext;
		try {
			return await callOperation(
				operation,
				intentContext.arguments,
				intentContext.context,
				via,
			);
		} catch (error) {
			const failure =
				error instanceof WhopMcpError
					? error
					: new WhopMcpError("internal_error", "Unexpected server error.");
			await auditSink.record(
				auditEvent(
					operation.toolName,
					operationKey(operation),
					principal,
					"failed",
					{
						clientName: options.clientName,
						pluginSource: options.pluginSource,
						errorCode: failure.code,
						upstreamStatus: failure.status,
						...(options.surface === "chatgpt"
							? { requestId: failure.requestId }
							: {}),
						...(via ? { via } : {}),
					},
				),
			);
			throw failure;
		}
	}

	async function callOperation(
		operation: OperationDef,
		rawArgs: Record<string, unknown>,
		intentContext: McpRequestContext | undefined,
		via?: OperationCallVia,
	): Promise<unknown> {
		const suppliedKey = rawArgs[IDEMPOTENCY_KEY_FIELD];
		const idempotencyKey =
			typeof suppliedKey === "string" ? suppliedKey : undefined;
		const args = { ...rawArgs };
		if (!operation.inputSchema.properties?.[IDEMPOTENCY_KEY_FIELD]) {
			delete args[IDEMPOTENCY_KEY_FIELD];
		}

		await options.beforeCall?.(operation, args, principal);
		const result = await dispatcher.dispatch(operation, args, principal, {
			idempotencyKey,
			mcpRequestContext: intentContext,
		});
		await auditSink.record(
			auditEvent(
				operation.toolName,
				operationKey(operation),
				principal,
				"executed",
				{
					clientName: options.clientName,
					pluginSource: options.pluginSource,
					requestId: result.requestId,
					...(via ? { via } : {}),
				},
			),
		);
		return options.surface === "chatgpt" &&
			operation.toolName === "accounts_list"
			? withoutTaxIdentifiers(result.body)
			: result.body;
	}

	return { server, operations };
}

function parseIntentContext(
	toolName: string,
	suppliedArgs: Record<string, unknown>,
):
	| { arguments: Record<string, unknown>; context: McpRequestContext }
	| WhopMcpError {
	const intent = suppliedArgs[INTENT_FIELD];
	if (typeof intent !== "string" || intent.trim().length === 0) {
		return new WhopMcpError(
			"invalid_input",
			`${toolName} requires a non-empty intent containing the user's original request.`,
		);
	}
	const suppliedIntentId = suppliedArgs[INTENT_ID_FIELD];
	if (
		typeof suppliedIntentId !== "string" ||
		!UUID_REGEX.test(suppliedIntentId)
	) {
		return new WhopMcpError(
			"invalid_input",
			`${toolName} requires intent_id to be a UUID reused across the current user turn.`,
		);
	}
	const intentId = suppliedIntentId.toLowerCase();
	const toolCallId = crypto.randomUUID();
	const {
		[INTENT_FIELD]: _intent,
		[INTENT_ID_FIELD]: _intentId,
		...operationArguments
	} = suppliedArgs;
	return {
		arguments: operationArguments,
		context: {
			intent,
			intentId,
			toolName,
			toolCallId,
		},
	};
}

function operationKey(operation: OperationDef): string {
	return `${operation.method.toUpperCase()} ${operation.path}`;
}

function supportsUpstreamReplay(operation: OperationDef): boolean {
	return operation.surface === "native" && operation.method === "post";
}

function connectionStatus(
	registry: RegistryManifest,
	principal: PrincipalContext,
	operations: OperationDef[],
	listedOperations: OperationDef[],
	surface: SurfaceName,
) {
	const byGroup: Record<string, number> = {};
	for (const op of operations) {
		byGroup[op.group] = (byGroup[op.group] ?? 0) + 1;
	}
	if (surface === "chatgpt") {
		return {
			user_name: principal.userName ?? null,
			account_id: principal.accountId,
			account_title: principal.accountTitle ?? null,
			permission_profile: principal.permissionProfile,
			tool_count: operations.length,
			tool_categories: byGroup,
		};
	}
	return {
		user_id: principal.userId ?? null,
		user_name: principal.userName ?? null,
		account_id: principal.accountId,
		account_title: principal.accountTitle ?? null,
		principal_type: principal.principalType,
		permission_profile: principal.permissionProfile,
		tool_surface: surface,
		granted_scopes: principal.scopes,
		tool_count: operations.length,
		listed_tool_count: listedOperations.length,
		tool_categories: byGroup,
		pending_review_count: registry.meta.pendingReview.length,
		server_version: SERVER_VERSION,
		api_version_date: registry.meta.apiVersionDate,
		openapi_sha256: registry.meta.openapiSha256,
		registry_generator_version: registry.meta.generatorVersion,
	};
}

// Write tools act on the first call. OpenAI says to keep the most important
// details in the first 512 characters, so this comes right after the header.
const CHATGPT_CONFIRMATION_INSTRUCTION =
	"Consequential tools (anything that costs money, goes live, affects other people, or can't be undone) act on the first call, so never call one just to see a preview. Tell the user what will happen, get their explicit yes, then call it.";

// This route leaves these out on purpose (see policy/surfaces.ts). Without this
// line the model offers a substitute, such as an invoice in place of a charge.
// The first sentence is kept short so it still ends inside the first 512
// characters.
const CHATGPT_UNAVAILABLE_INSTRUCTION =
	"This connection cannot issue refunds, charge saved cards, create invoices or send payouts: say so, offer no workaround. Tell the user they can do it in their Whop dashboard.";

// OpenAI's review turns down answers that echo personal data nobody asked
// for. The tools still return these fields, so a user who asks for one gets it.
const CHATGPT_PERSONAL_DATA_INSTRUCTION =
	"Do not volunteer customers' email addresses, phone numbers, postal addresses, IP addresses or card or bank details. Include one when the user asks for it or needs it to tell two customers apart.";

function buildInstructions(
	principal: PrincipalContext,
	surface: SurfaceName | undefined,
	operations: OperationDef[],
	listedOperations: OperationDef[],
	builtins: BuiltinTool[],
	collectsIntent: boolean,
): string {
	const toolCount =
		listedOperations.length === operations.length
			? `${operations.length} tools`
			: `${listedOperations.length} operations listed as tools, ${operations.length} callable`;
	return [
		`Whop MCP server. This connection is authenticated as ${
			principal.accountId
				? `account ${principal.accountId}`
				: "the user, across every business they can act on"
		} with the "${principal.permissionProfile}" permission profile (${toolCount}).`,
		...(surface === "chatgpt"
			? [
					CHATGPT_CONFIRMATION_INSTRUCTION,
					CHATGPT_UNAVAILABLE_INSTRUCTION,
					CHATGPT_PERSONAL_DATA_INSTRUCTION,
				]
			: []),
		principal.accountId
			? "Account binding is enforced server-side: input referencing a different account is rejected. Switching accounts requires the user to reconnect."
			: "Pick the context per call from what the user asks for: pass account_id/company_id when they mean a specific business (find it with accounts_list if they name it), and pass no account or user filter for questions about the user themselves, like the memberships they own across all of Whop.",
		...(collectsIntent
			? [
					"For each user message, generate one UUID intent_id and reuse it for every operation tool call made to fulfill that message. Copy the original user request into intent. Both fields are attribution metadata and are not sent as Whop API arguments.",
				]
			: []),
		...builtins.flatMap((tool) => tool.instruction ?? []),
		surface === "chatgpt"
			? "Call connection_status to see the signed-in user, account, permission profile, and tool coverage."
			: "Call connection_status to see the authenticated identity, account, scopes, and tool coverage.",
	].join("\n\n");
}
