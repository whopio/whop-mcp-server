import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
	CallToolRequestSchema,
	GetPromptRequestSchema,
	ListPromptsRequestSchema,
	ListResourcesRequestSchema,
	ListToolsRequestSchema,
	McpError,
	ReadResourceRequestSchema,
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
	DEFAULT_SURFACE,
	listedOnSurface,
	operationKey,
	type SurfaceName,
} from "../policy/surfaces.ts";
import { visibleOperations } from "../policy/visibility.ts";
import { Dispatcher } from "./dispatcher.ts";
import { WhopMcpError } from "./errors.ts";
import type { BuiltinTool, ToolDefinition } from "./builtin-tool.ts";
import { chatGptTools } from "./chatgpt-compat.ts";
import {
	CHATGPT_BUILTINS,
	CHATGPT_INSTRUCTIONS,
	chatgptBuiltins,
	chatgptOperations,
	rejectRemovedInputs,
	withoutHiddenFields,
} from "./chatgpt-route.ts";
import type { McpRequestContext } from "./mcp-context.ts";
import { docsTools } from "./docs.ts";
import { feedbackTools } from "./feedback.ts";
import { type OperationCall, operationTools } from "./operation-tools.ts";
import { getPrompt, listedPrompts } from "./prompts.ts";
import { listedResources, readResource } from "./resources.ts";
import {
	calledAs,
	operationsByName,
	REGISTRY_NAMING,
	type ToolNaming,
	verbNaming,
} from "./tool-names.ts";
import { toolReach } from "./tool-reach.ts";

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

// The MCP spec's code for a resource that doesn't exist.
const RESOURCE_NOT_FOUND = -32002;
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

export interface CreateWhopMcpServerOptions {
	registry: RegistryManifest;
	credentialAdapter: CredentialAdapter;
	principal: PrincipalContext;
	auditSink?: AuditSink;
	feedback?: boolean;
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
	/**
	 * The fixed tool subset this endpoint serves (see policy/surfaces.ts). The
	 * chatgpt surface lists only the operations in policy/chatgpt-tools.json
	 * plus its five built-ins, always in full, with no operation tools,
	 * feedback tools, docs_query, or guides.
	 */
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
	/**
	 * Serve the guide prompts and resources (runtime/prompts.ts and
	 * runtime/resources.ts), built from the flows in runtime/flows.ts. A prompt
	 * or flow is offered only when this connection can call every tool it
	 * needs, and a tool that isn't listed is named with the operation tool
	 * that runs it.
	 */
	promptsAndResources?: boolean;
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

function listedToolDescription(operation: OperationDef): string {
	const description = toolDescription(operation);
	return operation.listedSchemaOmit || operation.listedSchemaOnly
		? `${description}\n\n${LISTED_SCHEMA_OMIT_DESCRIPTION}`
		: description;
}

function toolDescription(operation: OperationDef): string {
	return operation.description || operation.summary || "";
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
	naming: ToolNaming,
): {
	content: { type: "text"; text: string }[];
	isError: boolean;
} {
	const result = error.toResult() as { error: Record<string, unknown> };
	// OpenAI's response rule names request IDs. The audit event keeps this one.
	if (surface === "chatgpt") delete result.error.request_id;
	if (typeof result.error.message === "string") {
		result.error.message = naming.inText(result.error.message);
	}
	return {
		content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
		isError: true,
	};
}

export function createWhopMcpServer(
	options: CreateWhopMcpServerOptions,
): WhopMcpServer {
	const { registry, principal } = options;
	const chatgpt = options.surface === "chatgpt";
	// Muse reviewed and approved its tools under their registry names.
	const naming =
		options.surface === "muse"
			? REGISTRY_NAMING
			: verbNaming(registry.operations);
	const errorContent = (error: WhopMcpError) =>
		errorContentFor(error, options.surface, naming);
	const visible = visibleOperations(registry, principal, {
		nativeOnly: options.nativeOnly,
		surface: options.surface,
	});
	const operations = chatgpt ? chatgptOperations(visible) : visible;
	// The ChatGPT route takes only the names it lists.
	const byName = chatgpt
		? new Map(operations.map((op) => [op.verbName, op]))
		: operationsByName(operations);
	// OpenAI bars search-and-call tools for operations that aren't listed on
	// their own, and the guides name tools by their registry names, so the
	// ChatGPT route lists every tool and serves no guides.
	const compact = options.toolListing === "compact" && !chatgpt;
	const guides = (options.promptsAndResources ?? false) && !chatgpt;
	// Muse approves each tool and bars collecting more data than a tool needs,
	// so its route offers only read-only operation tools and no intent fields.
	const reviewedToolsOnly = options.surface === "muse";
	// OpenAI allows a brief, task-specific intent field only when it improves
	// execution. This one is attribution only, so ChatGPT skips it too.
	const collectsIntent = !reviewedToolsOnly && !chatgpt;
	const intentSchema = (schema: JsonSchema, asksForIntent: boolean) =>
		collectsIntent && asksForIntent ? withIntentContext(schema) : schema;
	const listedOperations = compact
		? operations
				.filter((op) => listedOnSurface(op))
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
		filterResponse: chatgpt ? withoutHiddenFields : undefined,
	});

	const docsOptions = { fetch: options.fetch, timeoutMs: options.timeoutMs };
	const builtins: BuiltinTool[] = chatgpt
		? chatgptBuiltins({
				operations,
				dispatcher,
				principal,
				chatGptCompat: options.chatGptCompat,
				docs: options.docs ? docsOptions : undefined,
			})
		: [
				...(options.chatGptCompat
					? chatGptTools(operations, dispatcher, principal)
					: []),
				...(options.feedback
					? feedbackTools(
							dispatcher,
							principal,
							{
								clientName: options.clientName,
								pluginSource: options.pluginSource,
							},
							naming,
						)
					: []),
				...(options.docs ? docsTools(docsOptions) : []),
				...(compact
					? operationTools(
							operations,
							executeOperation,
							(operation) => withAccountRequirement(operation, principal),
							{ readOnly: reviewedToolsOnly, naming },
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
			capabilities: {
				tools: {},
				...(guides && { prompts: {}, resources: {} }),
			},
			instructions: naming.inText(
				buildInstructions(
					principal,
					options.surface,
					operations,
					listedOperations,
					builtins,
					collectsIntent,
					guides,
				),
			),
		},
	);

	server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: [
			...listedOperations.map((op) => ({
				name: naming.name(op.toolName),
				description: naming.inText(
					compact ? listedToolDescription(op) : toolDescription(op),
				),
				inputSchema: intentSchema(
					compact
						? listedInputSchema(op, principal)
						: toolInputSchema(op, principal),
					true,
				) as Record<string, unknown>,
				annotations: {
					readOnlyHint: op.annotations.readOnlyHint,
					destructiveHint: op.annotations.destructiveHint,
					idempotentHint: op.annotations.idempotentHint,
					openWorldHint: op.annotations.openWorldHint,
					title: op.summary,
				},
			})),
			...builtins.map((tool) => ({
				...tool.definition,
				inputSchema: intentSchema(
					tool.definition.inputSchema,
					tool.asksForIntent ?? false,
				) as ToolDefinition["inputSchema"],
			})),
		],
	}));

	if (guides) {
		const reach = toolReach(
			operations,
			listedOperations,
			builtinByName.keys(),
			naming,
		);
		server.setRequestHandler(ListPromptsRequestSchema, async () => ({
			prompts: listedPrompts(reach),
		}));
		server.setRequestHandler(GetPromptRequestSchema, async (request) =>
			getPrompt(request.params.name, request.params.arguments ?? {}, reach),
		);
		server.setRequestHandler(ListResourcesRequestSchema, async () => ({
			resources: listedResources(reach),
		}));
		server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
			const resource = readResource(request.params.uri, reach);
			if (!resource) {
				throw new McpError(
					RESOURCE_NOT_FOUND,
					`Unknown resource "${request.params.uri}".`,
				);
			}
			return { contents: [resource] };
		});
	}

	server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
		const { name, arguments: rawArgs = {} } = request.params;
		const builtin = builtinByName.get(name);
		const operation = builtin ? undefined : byName.get(name);
		try {
			const { arguments: args, context } = splitIntent(
				operation?.toolName ?? name,
				rawArgs,
				builtin ? builtin.asksForIntent === true : operation !== undefined,
			);
			if (builtin) {
				return {
					content: [
						{
							type: "text" as const,
							text: await builtin.call(args, extra.signal, context),
						},
					],
				};
			}
			if (operation) {
				return jsonContent(
					await executeOperation(operation, args, context, {
						calledAs: calledAs(operation, name),
					}),
				);
			}
		} catch (error) {
			return errorContent(
				error instanceof WhopMcpError
					? error
					: new WhopMcpError("internal_error", `${name} failed.`),
			);
		}
		return errorContent(
			new WhopMcpError(
				"tool_not_found",
				`Unknown tool "${name}" for this connection's profile and scopes.`,
			),
		);
	});

	function splitIntent(
		toolName: string,
		suppliedArgs: Record<string, unknown>,
		asksForIntent: boolean,
	): { arguments: Record<string, unknown>; context?: McpRequestContext } {
		return collectsIntent && asksForIntent
			? parseIntentContext(toolName, suppliedArgs)
			: { arguments: suppliedArgs };
	}

	async function executeOperation(
		operation: OperationDef,
		rawArgs: Record<string, unknown>,
		mcpRequestContext: McpRequestContext | undefined,
		call: OperationCall,
	): Promise<unknown> {
		try {
			return await callOperation(operation, rawArgs, mcpRequestContext, call);
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
						requestId: failure.requestId,
						...call,
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
		call: OperationCall,
	): Promise<unknown> {
		const suppliedKey = rawArgs[IDEMPOTENCY_KEY_FIELD];
		const idempotencyKey =
			typeof suppliedKey === "string" ? suppliedKey : undefined;
		const args = { ...rawArgs };
		if (!operation.inputSchema.properties?.[IDEMPOTENCY_KEY_FIELD]) {
			delete args[IDEMPOTENCY_KEY_FIELD];
		}

		if (chatgpt) rejectRemovedInputs(operation, args);
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
					...call,
				},
			),
		);
		return result.body;
	}

	return { server, operations };
}

function parseIntentContext(
	toolName: string,
	suppliedArgs: Record<string, unknown>,
): { arguments: Record<string, unknown>; context: McpRequestContext } {
	const intent = suppliedArgs[INTENT_FIELD];
	if (typeof intent !== "string" || intent.trim().length === 0) {
		throw new WhopMcpError(
			"invalid_input",
			`${toolName} requires a non-empty intent containing the user's original request.`,
		);
	}
	const suppliedIntentId = suppliedArgs[INTENT_ID_FIELD];
	if (
		typeof suppliedIntentId !== "string" ||
		!UUID_REGEX.test(suppliedIntentId)
	) {
		throw new WhopMcpError(
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

const GUIDES_INSTRUCTION =
	"Step-by-step guides for common Whop workflows are resources under whop://guides/. whop://guides/finding-tools shows how to reach operations that aren't in the tool list.";

function buildInstructions(
	principal: PrincipalContext,
	surface: SurfaceName | undefined,
	operations: OperationDef[],
	listedOperations: OperationDef[],
	builtins: BuiltinTool[],
	collectsIntent: boolean,
	guides: boolean,
): string {
	const chatgpt = surface === "chatgpt";
	const toolCount = chatgpt
		? `${listedOperations.length + builtins.length} tools`
		: listedOperations.length === operations.length
			? `${operations.length} tools`
			: `${listedOperations.length} operations listed as tools, ${operations.length} callable`;
	return [
		`Whop MCP server. This connection is authenticated as ${
			principal.accountId
				? `account ${principal.accountId}`
				: "the user, across every business they can act on"
		} with the "${principal.permissionProfile}" permission profile (${toolCount}).`,
		...(chatgpt ? CHATGPT_INSTRUCTIONS : []),
		principal.accountId
			? "Account binding is enforced server-side: input referencing a different account is rejected. Switching accounts requires the user to reconnect."
			: "Pick the context per call from what the user asks for: pass account_id/company_id when they mean a specific business (find it with accounts_list if they name it), and pass no account or user filter for questions about the user themselves, like the memberships they own across all of Whop.",
		...(collectsIntent
			? [
					"For each user message, generate one UUID intent_id and reuse it for every tool call that asks for intent_id while fulfilling that message. Copy the original user request into intent. Both fields are attribution metadata and are not sent as Whop API arguments.",
				]
			: []),
		...builtins.flatMap((tool) => tool.instruction ?? []),
		...(guides ? [GUIDES_INSTRUCTION] : []),
		chatgpt
			? `Call ${CHATGPT_BUILTINS.connection_status.name} to see the signed-in user, account, permission profile, and tool coverage.`
			: "Call connection_status to see the authenticated identity, account, scopes, and tool coverage.",
	].join("\n\n");
}
