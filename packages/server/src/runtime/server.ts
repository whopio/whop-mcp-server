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
import { DEFAULT_SURFACE, type SurfaceName } from "../policy/surfaces.ts";
import { visibleOperations } from "../policy/visibility.ts";
import { Dispatcher } from "./dispatcher.ts";
import { WhopMcpError } from "./errors.ts";
import type { BuiltinTool, ToolDefinition } from "./builtin-tool.ts";
import { chatGptTools } from "./chatgpt-compat.ts";
import type { McpRequestContext } from "./mcp-context.ts";
import { docsTools } from "./docs.ts";
import { feedbackTools, type FeedbackSink } from "./feedback.ts";

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

function errorContent(error: WhopMcpError): {
	content: { type: "text"; text: string }[];
	isError: boolean;
} {
	return {
		content: [
			{ type: "text", text: JSON.stringify(error.toResult(), null, 2) },
		],
		isError: true,
	};
}

export function createWhopMcpServer(
	options: CreateWhopMcpServerOptions,
): WhopMcpServer {
	const { registry, principal } = options;
	const operations = visibleOperations(registry, principal, {
		nativeOnly: options.nativeOnly,
		surface: options.surface,
	});
	const byName = new Map(operations.map((op) => [op.toolName, op]));

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
			? chatGptTools(operations, dispatcher, principal)
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
		{
			definition: CONNECTION_STATUS_TOOL,
			call: async () =>
				JSON.stringify(
					connectionStatus(
						registry,
						principal,
						operations,
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
			instructions: buildInstructions(principal, operations, builtins),
		},
	);

	server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: [
			...operations.map((op) => ({
				name: op.toolName,
				description: toolDescription(op),
				inputSchema: withIntentContext(
					toolInputSchema(op, principal),
				) as Record<string, unknown>,
				annotations: {
					readOnlyHint: op.annotations.readOnlyHint,
					destructiveHint: op.annotations.destructiveHint,
					idempotentHint: op.annotations.idempotentHint,
					openWorldHint: op.annotations.openWorldHint,
					title: op.summary,
				},
			})),
			...builtins.map((tool) => tool.definition),
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
		const intentContext = parseIntentContext(name, rawArgs);
		if (intentContext instanceof WhopMcpError) {
			return errorContent(intentContext);
		}

		try {
			return await callOperation(
				operation,
				intentContext.arguments,
				intentContext.context,
			);
		} catch (error) {
			if (error instanceof WhopMcpError) {
				await auditSink.record(
					auditEvent(
						operation.toolName,
						operationKey(operation),
						principal,
						"failed",
						{
							clientName: options.clientName,
							pluginSource: options.pluginSource,
							errorCode: error.code,
							upstreamStatus: error.status,
						},
					),
				);
				return errorContent(error);
			}
			await auditSink.record(
				auditEvent(
					operation.toolName,
					operationKey(operation),
					principal,
					"failed",
					{
						clientName: options.clientName,
						pluginSource: options.pluginSource,
						errorCode: "internal_error",
					},
				),
			);
			return errorContent(
				new WhopMcpError("internal_error", "Unexpected server error."),
			);
		}
	});

	async function callOperation(
		operation: OperationDef,
		rawArgs: Record<string, unknown>,
		intentContext: McpRequestContext,
	) {
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
				},
			),
		);
		return jsonContent(result.body);
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
		tool_categories: byGroup,
		pending_review_count: registry.meta.pendingReview.length,
		server_version: SERVER_VERSION,
		api_version_date: registry.meta.apiVersionDate,
		openapi_sha256: registry.meta.openapiSha256,
		registry_generator_version: registry.meta.generatorVersion,
	};
}

function buildInstructions(
	principal: PrincipalContext,
	operations: OperationDef[],
	builtins: BuiltinTool[],
): string {
	return [
		`Whop MCP server. This connection is authenticated as ${
			principal.accountId
				? `account ${principal.accountId}`
				: "the user, across every business they can act on"
		} with the "${principal.permissionProfile}" permission profile (${operations.length} tools).`,
		principal.accountId
			? "Account binding is enforced server-side: input referencing a different account is rejected. Switching accounts requires the user to reconnect."
			: "Pick the context per call from what the user asks for: pass account_id/company_id when they mean a specific business (find it with accounts_list if they name it), and pass no account or user filter for questions about the user themselves, like the memberships they own across all of Whop.",
		"For each user message, generate one UUID intent_id and reuse it for every operation tool call made to fulfill that message. Copy the original user request into intent. Both fields are attribution metadata and are not sent as Whop API arguments.",
		...builtins.flatMap((tool) => tool.instruction ?? []),
		"Call connection_status to see the authenticated identity, account, scopes, and tool coverage.",
	].join("\n\n");
}
