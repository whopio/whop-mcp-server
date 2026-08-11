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
import { ConfirmationSigner, hashArguments } from "../safety/confirmation.ts";
import {
	InMemoryIdempotencyStore,
	type IdempotencyRecord,
	type IdempotencyStore,
} from "../safety/idempotency.ts";
import { visibleOperations } from "../policy/visibility.ts";
import { Dispatcher } from "./dispatcher.ts";
import { WhopMcpError } from "./errors.ts";
import {
	FETCH_TOOL,
	runFetch,
	runSearch,
	SEARCH_TOOL,
} from "./chatgpt-compat.ts";

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

const MCP_CONFIRMATION_TOKEN_FIELD = "mcp_confirmation_token";
const IDEMPOTENCY_KEY_FIELD = "idempotency_key";
const CONNECTION_STATUS_TOOL = "connection_status";

/**
 * How confirmation-required operations are gated.
 *
 *   "enforce"        the server runs the prepare/confirm token flow itself.
 *                    The hosted worker uses this: it cannot trust every MCP
 *                    client to interpose human approval.
 *   "host-approval"  confirmation-required operations execute directly. The
 *                    stdio adapter defaults to this: local hosts (Claude
 *                    Code, Claude Desktop, Cursor, VS Code) already prompt
 *                    per call, and destructiveHint disables auto-approve.
 */
export type ConfirmationMode = "enforce" | "host-approval";

export interface CreateWhopMcpServerOptions {
	registry: RegistryManifest;
	credentialAdapter: CredentialAdapter;
	principal: PrincipalContext;
	confirmationMode?: ConfirmationMode;
	/** Required when confirmationMode is "enforce". */
	confirmationSecret?: string;
	idempotencyStore?: IdempotencyStore;
	auditSink?: AuditSink;
	fetch?: typeof fetch;
	baseUrl?: string;
	timeoutMs?: number;
	maxResponseBytes?: number;
	clientName?: string;
	now?: () => number;
	confirmationTtlMs?: number;
	/** Restrict to the native REST surface (full surface by default). */
	nativeOnly?: boolean;
	/** Extra headers stamped on every upstream request (attribution). */
	extraHeaders?: Record<string, string>;
	/**
	 * Policy hook invoked after validation, immediately before an operation
	 * executes (on both direct and confirmed executions). Throw a WhopMcpError
	 * to block the call.
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

function toolInputSchema(
	operation: OperationDef,
	enforceConfirmation: boolean,
): JsonSchema {
	const confirmed =
		enforceConfirmation && operation.safety.confirmationRequired;
	const offersIdempotencyKey =
		operation.safety.confirmationRequired ||
		operation.safety.idempotency !== "none";
	if (!confirmed && !offersIdempotencyKey) {
		return operation.inputSchema;
	}

	const properties: Record<string, JsonSchema> = {
		...operation.inputSchema.properties,
	};
	if (confirmed) {
		properties[MCP_CONFIRMATION_TOKEN_FIELD] = {
			type: "string",
			description:
				"Leave unset on the first call to prepare this operation and receive a confirmation token. Pass the token back, after the user approves, to execute.",
		};
	}
	if (offersIdempotencyKey) {
		const upstreamReplay = supportsUpstreamReplay(operation);
		properties[IDEMPOTENCY_KEY_FIELD] = {
			type: "string",
			description: upstreamReplay
				? confirmed
					? "Caller-chosen stable retry key. Required when executing with a confirmation token; reuse the same key when retrying. The native API replays completed requests and rejects requests still in flight."
					: "Caller-chosen stable retry key. Reuse the same key when retrying after a timeout or error. The native API replays completed requests and rejects requests still in flight."
				: confirmed
					? "Caller-chosen stable key for local replay and conflict detection. Required when executing with a confirmation token; reuse the same key when retrying. If the outcome is reported as unknown, verify the effect instead of executing again."
					: "Caller-chosen stable key forwarded to the API. Reuse the same key when retrying, but verify the operation outcome after an ambiguous error.",
		};
	}
	return { ...operation.inputSchema, properties };
}

function toolDescription(
	operation: OperationDef,
	enforceConfirmation: boolean,
): string {
	const parts: string[] = [];
	if (operation.description) parts.push(operation.description);
	else if (operation.summary) parts.push(operation.summary);
	if (enforceConfirmation && operation.safety.confirmationRequired) {
		parts.push(
			"Two-step tool. Without mcp_confirmation_token, calling it is a SAFE PREVIEW: nothing executes, no money moves, no data changes — it returns exactly what would happen plus a confirmation token. Show that preview to the user. Executing is the user's decision, not yours: call again with the token once they approve, in the moment or through standing permission they have given you.",
		);
	}
	return parts.join("\n\n");
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
	const confirmationMode = options.confirmationMode ?? "enforce";
	const enforceConfirmation = confirmationMode === "enforce";
	if (enforceConfirmation && !options.confirmationSecret) {
		throw new Error(
			'createWhopMcpServer requires confirmationSecret when confirmationMode is "enforce".',
		);
	}

	const operations = visibleOperations(registry, principal, {
		nativeOnly: options.nativeOnly,
	});
	const byName = new Map(operations.map((op) => [op.toolName, op]));

	const auditSink = options.auditSink ?? new InMemoryAuditSink();
	const idempotencyStore =
		options.idempotencyStore ?? new InMemoryIdempotencyStore();
	const signer = options.confirmationSecret
		? new ConfirmationSigner(options.confirmationSecret, {
				now: options.now,
				ttlMs: options.confirmationTtlMs,
			})
		: null;
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

	const server = new Server(
		{ name: SERVER_NAME, version: SERVER_VERSION, icons: SERVER_ICONS },
		{
			capabilities: { tools: {} },
			instructions: buildInstructions(
				principal,
				operations,
				enforceConfirmation,
			),
		},
	);

	server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: [
			...operations.map((op) => ({
				name: op.toolName,
				description: toolDescription(op, enforceConfirmation),
				inputSchema: toolInputSchema(op, enforceConfirmation) as Record<
					string,
					unknown
				>,
				annotations: {
					readOnlyHint: op.annotations.readOnlyHint,
					destructiveHint: op.annotations.destructiveHint,
					idempotentHint: op.annotations.idempotentHint,
					openWorldHint: op.annotations.openWorldHint,
					title: op.summary,
				},
			})),
			...(options.chatGptCompat ? [SEARCH_TOOL, FETCH_TOOL] : []),
			{
				name: CONNECTION_STATUS_TOOL,
				description:
					"Returns safe diagnostics for this connection: authenticated identity, selected account, permission profile, scopes, tool coverage, and build metadata. Never returns credentials.",
				inputSchema: {
					type: "object",
					properties: {},
					additionalProperties: false,
				},
				annotations: { readOnlyHint: true },
			},
		],
	}));

	server.setRequestHandler(CallToolRequestSchema, async (request) => {
		const { name, arguments: rawArgs = {} } = request.params;

		if (name === CONNECTION_STATUS_TOOL) {
			return jsonContent(connectionStatus(registry, principal, operations));
		}

		if (options.chatGptCompat && name === SEARCH_TOOL.name) {
			const query = typeof rawArgs.query === "string" ? rawArgs.query : "";
			return jsonContent(
				await runSearch(query, operations, dispatcher, principal),
			);
		}
		if (options.chatGptCompat && name === FETCH_TOOL.name) {
			const id = typeof rawArgs.id === "string" ? rawArgs.id : "";
			const fetched = await runFetch(id, operations, dispatcher, principal);
			if (!fetched) {
				return errorContent(
					new WhopMcpError(
						"invalid_input",
						`No fetchable resource for id "${id}". Use an id returned by search.`,
					),
				);
			}
			return jsonContent(fetched);
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
			return await callOperation(operation, rawArgs as Record<string, unknown>);
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
							errorCode: error.code,
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
						errorCode: "internal_error",
					},
				),
			);
			return errorContent(
				new WhopMcpError("internal_error", "Unexpected server error."),
			);
		}
	});

	async function executeDirect(
		operation: OperationDef,
		args: Record<string, unknown>,
		idempotencyKey: string | undefined,
	) {
		await options.beforeCall?.(operation, args, principal);
		const result = await dispatcher.dispatch(operation, args, principal, {
			idempotencyKey,
		});
		await auditSink.record(
			auditEvent(
				operation.toolName,
				operationKey(operation),
				principal,
				"executed",
				{
					clientName: options.clientName,
					requestId: result.requestId,
				},
			),
		);
		return jsonContent(result.body);
	}

	async function callOperation(
		operation: OperationDef,
		rawArgs: Record<string, unknown>,
	) {
		const { [MCP_CONFIRMATION_TOKEN_FIELD]: mcpConfirmationToken, ...rest } =
			rawArgs;
		const declaresIdempotencyKey = Boolean(
			operation.inputSchema.properties?.[IDEMPOTENCY_KEY_FIELD],
		);
		const idempotencyKey =
			typeof rest[IDEMPOTENCY_KEY_FIELD] === "string"
				? (rest[IDEMPOTENCY_KEY_FIELD] as string)
				: undefined;
		const args = { ...rest };
		if (!declaresIdempotencyKey) delete args[IDEMPOTENCY_KEY_FIELD];

		if (!enforceConfirmation || !operation.safety.confirmationRequired) {
			return executeDirect(operation, args, idempotencyKey);
		}

		if (!signer) {
			throw new WhopMcpError("internal_error", "Confirmation is unavailable.");
		}

		// Validate (including account binding and injection) on BOTH steps, and
		// hash the injected form: prepare returns the injected arguments, so the
		// client may resubmit either that or its original shape — both must
		// normalize to the same token hash. The idempotency key is retry
		// control, not operation semantics, so it never enters the hash.
		const injectedArgs = dispatcher.validate(operation, args, principal);
		const hashableArgs = { ...injectedArgs };
		delete hashableArgs[IDEMPOTENCY_KEY_FIELD];

		if (typeof mcpConfirmationToken !== "string") {
			const issued = await signer.issue(
				operation.toolName,
				hashableArgs,
				principal,
			);
			await auditSink.record(
				auditEvent(
					operation.toolName,
					operationKey(operation),
					principal,
					"prepared",
					{
						clientName: options.clientName,
					},
				),
			);
			return jsonContent({
				prepared: true,
				executed: false,
				operation: operation.toolName,
				effect: operation.summary ?? operationKey(operation),
				// Unbound connections have no grant-level account — name the one
				// this call targets so the approval prompt still shows a business.
				account_id:
					principal.accountId ?? targetAccount(operation, injectedArgs),
				arguments: injectedArgs,
				mcp_confirmation_token: issued.token,
				expires_at: issued.expiresAt,
				next_step: supportsUpstreamReplay(operation)
					? "Show the user what will happen. After they approve, call this tool again with the same arguments plus mcp_confirmation_token and a stable idempotency_key. Keep using the SAME idempotency_key if you have to retry or re-prepare this operation."
					: "Show the user what will happen. After they approve, call this tool again with the same arguments plus mcp_confirmation_token and a stable idempotency_key. Keep using the SAME idempotency_key for local replay. If the server reports an unknown outcome, verify the effect instead of executing again.",
			});
		}

		const confirmation = await signer.verify(
			mcpConfirmationToken,
			operation.toolName,
			hashableArgs,
			principal,
		);

		const argsHash = await hashArguments(hashableArgs);
		// User-scoped: two users must never share a replay cache even when they
		// share an account (or when both connections are unbound).
		const idempotencyScope = `${principal.userId ?? "-"}:${principal.accountId ?? "-"}:${operation.toolName}`;

		// Every confirmed execution requires a caller-chosen stable key: it is
		// the only identifier that survives a re-prepare (a new token means a
		// new jti), so it must anchor both the local replay cache and the
		// upstream Idempotency-Key.
		if (!idempotencyKey) {
			throw new WhopMcpError(
				"invalid_input",
				`${operation.toolName} requires an idempotency_key when executing.`,
			);
		}

		const callerKey = `${idempotencyScope}:${idempotencyKey}`;
		const upstreamKey = await hashArguments({
			scope: idempotencyScope,
			key: idempotencyKey,
		});
		const readCallerCompletion = async () => {
			try {
				const record = await idempotencyStore.get(callerKey);
				if (
					!record ||
					record.argsHash !== argsHash ||
					(record.version === 2 && record.callerKeyHash !== upstreamKey)
				) {
					return { found: false as const };
				}
				return completedResult(record);
			} catch {
				return { found: false as const };
			}
		};
		const canReconcileUpstream = supportsUpstreamReplay(operation);
		const ownerId = crypto.randomUUID();
		const claimInput = {
			argsHash,
			callerKeyHash: upstreamKey,
			ownerId,
		};
		const unknownOutcome = () =>
			new WhopMcpError(
				"outcome_unknown",
				"The execution may have completed, but its outcome cannot be confirmed safely. Verify the operation's effect before preparing another execution, and do not retry it with a new idempotency_key.",
			);
		const replay = async (result: unknown) => {
			await auditSink.record(
				auditEvent(
					operation.toolName,
					operationKey(operation),
					principal,
					"replayed",
					{ clientName: options.clientName },
				),
			);
			return jsonContent(result);
		};
		const markOutcomeUnknown = async () => {
			const unknownAt = new Date().toISOString();
			await Promise.allSettled([
				idempotencyStore.markUnknown(callerKey, ownerId, unknownAt),
				idempotencyStore.markUnknown(
					`confirmation:${confirmation.jti}`,
					ownerId,
					unknownAt,
				),
			]);
		};

		const confirmationUseKey = `confirmation:${confirmation.jti}`;
		const confirmationClaim = await idempotencyStore.claim(
			confirmationUseKey,
			claimInput,
			{ takeoverIncomplete: canReconcileUpstream },
		);
		const confirmationRecord = confirmationClaim.record;
		if (
			confirmationRecord.argsHash !== argsHash ||
			(confirmationRecord.version === 2 &&
				confirmationRecord.callerKeyHash !== upstreamKey)
		) {
			throw new WhopMcpError(
				"confirmation_invalid",
				"This confirmation token is already bound to another execution. Retry with its original arguments and idempotency_key.",
			);
		}
		const confirmationResult = completedResult(confirmationRecord);
		if (confirmationResult.found) {
			return replay(confirmationResult.result);
		}
		if (
			confirmationRecord.version === 2 &&
			confirmationRecord.state === "outcome_unknown"
		) {
			const callerCompletion = await readCallerCompletion();
			if (callerCompletion.found) {
				return replay(callerCompletion.result);
			}
			throw unknownOutcome();
		}
		if (confirmationRecord.version !== 2) {
			const legacyCaller = await idempotencyStore.get(callerKey);
			const legacyCallerResult = legacyCaller
				? completedResult(legacyCaller)
				: { found: false as const };
			if (
				legacyCaller &&
				legacyCaller.argsHash === argsHash &&
				legacyCallerResult.found
			) {
				return replay(legacyCallerResult.result);
			}
			throw unknownOutcome();
		}

		const callerClaim = await idempotencyStore.claim(callerKey, claimInput, {
			takeoverIncomplete: canReconcileUpstream,
		});
		const callerRecord = callerClaim.record;
		if (
			callerRecord.argsHash !== argsHash ||
			(callerRecord.version === 2 && callerRecord.callerKeyHash !== upstreamKey)
		) {
			throw new WhopMcpError(
				"idempotency_conflict",
				"This idempotency key was already used with different arguments. Prepare again with a new key for a new operation.",
			);
		}
		const callerResult = completedResult(callerRecord);
		if (callerResult.found) {
			await Promise.allSettled([
				idempotencyStore.complete(
					confirmationUseKey,
					ownerId,
					callerResult.result,
					new Date().toISOString(),
				),
			]);
			return replay(callerResult.result);
		}
		if (
			callerRecord.version !== 2 ||
			callerRecord.state === "outcome_unknown"
		) {
			throw unknownOutcome();
		}
		if (callerClaim.status === "existing") {
			throw new WhopMcpError(
				"idempotency_conflict",
				"An execution with this idempotency key is unfinished. It may still be in flight or may have completed without a stored result. Retry with the same mcp_confirmation_token, arguments, and idempotency_key after a short wait. If it remains unresolved, verify the operation's effect; do not prepare a replacement execution.",
			);
		}

		let result: Awaited<ReturnType<typeof dispatcher.dispatch>>;
		try {
			await options.beforeCall?.(operation, injectedArgs, principal);
		} catch (error) {
			if (callerClaim.status === "acquired") {
				await Promise.allSettled([
					idempotencyStore.release(callerKey, ownerId),
				]);
			}
			throw error;
		}

		try {
			// Execute exactly the injected form the user approved and the token
			// was hashed over.
			result = await dispatcher.dispatch(operation, injectedArgs, principal, {
				idempotencyKey: upstreamKey,
			});
		} catch (error) {
			if (!canReconcileUpstream) {
				await markOutcomeUnknown();
				throw unknownOutcome();
			}
			throw error;
		}

		const completedAt = new Date().toISOString();
		let completedBody = result.body;
		let completion: Awaited<ReturnType<IdempotencyStore["complete"]>>;
		try {
			completion = await idempotencyStore.complete(
				callerKey,
				ownerId,
				result.body,
				completedAt,
			);
		} catch {
			const callerCompletion = await readCallerCompletion();
			if (callerCompletion.found) {
				completion = "already_completed";
				completedBody = callerCompletion.result;
			} else if (!canReconcileUpstream) {
				await markOutcomeUnknown();
				throw unknownOutcome();
			} else {
				throw new WhopMcpError(
					"internal_error",
					"The operation may have completed, but its response could not be stored. Retry with the same mcp_confirmation_token, arguments, and idempotency_key.",
				);
			}
		}
		if (
			!canReconcileUpstream &&
			completion !== "completed" &&
			completion !== "already_completed"
		) {
			await markOutcomeUnknown();
			throw unknownOutcome();
		}
		await Promise.allSettled([
			idempotencyStore.complete(
				confirmationUseKey,
				ownerId,
				completedBody,
				completedAt,
			),
		]);

		await auditSink.record(
			auditEvent(
				operation.toolName,
				operationKey(operation),
				principal,
				"executed",
				{
					clientName: options.clientName,
					requestId: result.requestId,
				},
			),
		);
		return jsonContent(completedBody);
	}

	return { server, operations };
}

function operationKey(operation: OperationDef): string {
	return `${operation.method.toUpperCase()} ${operation.path}`;
}

function supportsUpstreamReplay(operation: OperationDef): boolean {
	return operation.surface === "native" && operation.method === "post";
}

function completedResult(
	record: IdempotencyRecord,
): { found: true; result: unknown } | { found: false } {
	if (record.version === 2) {
		return record.state === "completed"
			? { found: true, result: record.result }
			: { found: false };
	}
	return Object.hasOwn(record, "result")
		? { found: true, result: record.result }
		: { found: false };
}

/**
 * Only the declared account parameter is trusted — other biz_ fields may
 * name a counterparty rather than the acting business.
 */
function targetAccount(
	operation: OperationDef,
	args: Record<string, unknown>,
): string | null {
	if (!operation.accountParam) return null;
	const value = args[operation.accountParam];
	return typeof value === "string" ? value : null;
}

function connectionStatus(
	registry: RegistryManifest,
	principal: PrincipalContext,
	operations: OperationDef[],
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
	enforceConfirmation: boolean,
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
		...(enforceConfirmation
			? [
					"Consequential tools (payments, refunds, transfers, withdrawals, deletions, credentials) are two-step. The first call is a safe, side-effect-free preview — it is how the user sees exactly what would happen, so always make it when asked. Execution is the user's decision: by default show the preview and get their approval, but explicit standing permission from the user to act without confirmations also counts.",
				]
			: []),
		"Call connection_status to see the authenticated identity, account, scopes, and tool coverage.",
	].join("\n\n");
}
