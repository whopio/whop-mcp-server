import type { OperationDef } from "../registry/types.ts";
import type { CredentialAdapter, PrincipalContext } from "../policy/types.ts";
import { enforceAccountBinding } from "../policy/account-binding.ts";
import { operationVisibleToPrincipal } from "../policy/visibility.ts";
import { normalizeUpstreamError, WhopMcpError } from "./errors.ts";
import {
	encodeMcpRequestContext,
	MCP_CONTEXT_HEADER,
	type McpRequestContext,
} from "./mcp-context.ts";
import { validateAgainstSchema } from "./validate.ts";

export interface DispatcherOptions {
	baseUrl: string;
	apiVersionDate: string;
	credentialAdapter: CredentialAdapter;
	fetch?: typeof fetch;
	timeoutMs?: number;
	maxResponseBytes?: number;
	userAgent?: string;
	/** Extra headers stamped on every upstream request (attribution). */
	extraHeaders?: Record<string, string>;
}

export interface DispatchOverrides {
	/**
	 * Deterministic Idempotency-Key for this call. The confirmation flow hashes
	 * the caller's stable retry key with its user, account, and operation scope.
	 */
	idempotencyKey?: string;
	mcpRequestContext?: McpRequestContext;
	extraHeaders?: Record<string, string>;
}

export interface PreparedDispatch {
	readonly args: Readonly<Record<string, unknown>>;
	readonly method: string;
	readonly url: string;
	readonly body: Readonly<Record<string, unknown>> | undefined;
	readonly idempotencyKey: string | undefined;
}

interface RegisteredPreparedDispatch {
	readonly sourceOperation: OperationDef;
	readonly operation: OperationDef;
	readonly request: PreparedDispatch;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESPONSE_BYTES = 512_000;

function immutableCopy<T>(value: T): T {
	if (Array.isArray(value)) {
		return Object.freeze(value.map((entry) => immutableCopy(entry))) as T;
	}
	if (value !== null && typeof value === "object") {
		return Object.freeze(
			Object.fromEntries(
				Object.entries(value).map(([key, entry]) => [
					key,
					immutableCopy(entry),
				]),
			),
		) as T;
	}
	return value;
}

/** Path values must be a single, plain segment — no traversal, no separators. */
const SAFE_PATH_VALUE = /^[A-Za-z0-9][A-Za-z0-9._@-]*$/;

export class Dispatcher {
	private readonly options: DispatcherOptions;
	private readonly preparedDispatches = new WeakMap<
		PreparedDispatch,
		RegisteredPreparedDispatch
	>();

	constructor(options: DispatcherOptions) {
		this.options = options;
	}

	/**
	 * Enforces account binding, injects the bound account, and validates the
	 * result against the tool schema (and full request-body schema, including
	 * oneOf variant requirements). Returns the injected args. Also used by the
	 * prepare step so users only ever approve operations that can execute.
	 */
	validate(
		operation: OperationDef,
		rawArgs: Record<string, unknown>,
		principal: PrincipalContext,
	): Record<string, unknown> {
		const args = enforceAccountBinding(operation, rawArgs, principal);

		const validationErrors = validateAgainstSchema(args, operation.inputSchema);
		if (validationErrors.length > 0) {
			throw new WhopMcpError(
				"invalid_input",
				`Input does not match the ${operation.toolName} schema: ${validationErrors.slice(0, 5).join("; ")}`,
			);
		}

		if (operation.bodySchema) {
			const body = this.buildBody(operation, args);
			const bodyErrors = validateAgainstSchema(
				body ?? {},
				operation.bodySchema,
			);
			if (bodyErrors.length > 0) {
				throw new WhopMcpError(
					"invalid_input",
					`Request body does not match the ${operation.toolName} schema: ${bodyErrors.slice(0, 5).join("; ")}`,
				);
			}
		}

		return args;
	}

	prepare(
		operation: OperationDef,
		rawArgs: Record<string, unknown>,
		principal: PrincipalContext,
		overrides: Pick<DispatchOverrides, "idempotencyKey"> = {},
	): PreparedDispatch {
		const args = this.validate(operation, rawArgs, principal);
		const request = {
			args,
			method: operation.method.toUpperCase(),
			url: this.buildUrl(operation, args),
			body: this.buildBody(operation, args),
			idempotencyKey: overrides.idempotencyKey,
		};
		const handle = immutableCopy(request);
		this.preparedDispatches.set(handle, {
			sourceOperation: operation,
			operation: immutableCopy(operation),
			request: immutableCopy(request),
		});
		return handle;
	}

	async dispatch(
		operation: OperationDef,
		rawArgs: Record<string, unknown>,
		principal: PrincipalContext,
		overrides: DispatchOverrides = {},
	): Promise<{ status: number; requestId?: string; body: unknown }> {
		const resolvedOverrides = {
			...overrides,
			idempotencyKey:
				overrides.idempotencyKey ??
				(operation.safety.idempotency !== "none"
					? crypto.randomUUID()
					: undefined),
		};
		const prepared = this.prepare(
			operation,
			rawArgs,
			principal,
			resolvedOverrides,
		);
		return this.dispatchPrepared(operation, prepared, principal, {
			extraHeaders: resolvedOverrides.extraHeaders,
			mcpRequestContext: resolvedOverrides.mcpRequestContext,
		});
	}

	async dispatchPrepared(
		operation: OperationDef,
		prepared: PreparedDispatch,
		principal: PrincipalContext,
		overrides: Omit<DispatchOverrides, "idempotencyKey"> = {},
	): Promise<{ status: number; requestId?: string; body: unknown }> {
		const registered = this.preparedDispatches.get(prepared);
		if (
			!registered ||
			registered.sourceOperation !== operation ||
			registered.operation.toolName !== operation.toolName ||
			registered.operation.openapiOperationId !== operation.openapiOperationId
		) {
			throw new WhopMcpError(
				"confirmation_invalid",
				"The prepared request is invalid or belongs to a different operation.",
			);
		}

		const operationSnapshot = registered.operation;
		const request = registered.request;
		if (!operationVisibleToPrincipal(operationSnapshot, principal)) {
			throw new WhopMcpError(
				"missing_scope",
				`The credential cannot execute ${operationSnapshot.toolName}.`,
			);
		}

		const { url, body, idempotencyKey } = request;

		const { token } = await this.options.credentialAdapter.getCredential();

		const controller = new AbortController();
		const timeout = setTimeout(
			() => controller.abort(),
			this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
		);

		let response: Response;
		try {
			response = await (this.options.fetch ?? fetch)(url, {
				method: request.method,
				headers: {
					Authorization: `Bearer ${token}`,
					"Api-Version-Date": this.options.apiVersionDate,
					...(body !== undefined ? { "Content-Type": "application/json" } : {}),
					...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
					...(this.options.userAgent
						? { "User-Agent": this.options.userAgent }
						: {}),
					...this.options.extraHeaders,
					...overrides.extraHeaders,
					...(overrides.mcpRequestContext
						? {
								[MCP_CONTEXT_HEADER]: encodeMcpRequestContext(
									overrides.mcpRequestContext,
								),
							}
						: {}),
				},
				body: body !== undefined ? JSON.stringify(body) : undefined,
				// Workers do not implement "error". Manual mode returns the 3xx
				// response without replaying bearer or attribution headers.
				redirect: "manual",
				signal: controller.signal,
			});
		} catch (cause) {
			clearTimeout(timeout);
			if (controller.signal.aborted) {
				throw new WhopMcpError(
					"timeout",
					`${operationSnapshot.toolName} timed out after ${this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms.`,
				);
			}
			throw new WhopMcpError(
				"upstream_error",
				`Could not reach the Whop API: ${cause instanceof Error ? cause.message : "unknown error"}`,
			);
		}

		const requestId =
			response.headers.get("x-request-id") ??
			response.headers.get("cf-ray") ??
			undefined;
		if (response.status >= 300 && response.status < 400) {
			clearTimeout(timeout);
			await response.body?.cancel().catch(() => {});
			throw new WhopMcpError(
				"upstream_error",
				`${operationSnapshot.toolName} received an unexpected 3xx response from the Whop API.`,
				{ status: response.status, requestId },
			);
		}

		// The abort timer stays armed through the body read so a slow-trickling
		// response cannot hang the tool call past the deadline.
		let text: string;
		try {
			text = await response.text();
		} catch (cause) {
			if (controller.signal.aborted) {
				throw new WhopMcpError(
					"timeout",
					`${operationSnapshot.toolName} timed out after ${this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms while reading the response.`,
					{ status: response.status, requestId },
				);
			}
			throw new WhopMcpError(
				"upstream_error",
				`Failed reading the Whop API response: ${cause instanceof Error ? cause.message : "unknown error"}`,
				{ status: response.status, requestId },
			);
		} finally {
			clearTimeout(timeout);
		}

		const maxBytes =
			this.options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
		if (text.length > maxBytes) {
			throw new WhopMcpError(
				"response_too_large",
				`${operationSnapshot.toolName} returned ${text.length} characters (limit ${maxBytes}). Narrow the request with filters or pagination.`,
				{ status: response.status, requestId },
			);
		}

		let parsed: unknown;
		try {
			parsed = text.length > 0 ? JSON.parse(text) : null;
		} catch {
			parsed = null;
		}

		if (!response.ok) {
			throw normalizeUpstreamError(response.status, parsed, requestId);
		}

		this.enforceResponseOwnership(
			operationSnapshot,
			parsed,
			principal,
			requestId,
		);

		if (
			["Apps", "Cards"].includes(operationSnapshot.tag) &&
			parsed !== null &&
			typeof parsed === "object"
		) {
			const resources =
				"data" in parsed && Array.isArray(parsed.data) ? parsed.data : [parsed];
			for (const resource of resources) {
				if (
					resource !== null &&
					typeof resource === "object" &&
					"secrets" in resource &&
					resource.secrets !== null
				) {
					resource.secrets = "[redacted]";
				}
			}
		}

		return { status: response.status, requestId, body: parsed };
	}

	/**
	 * Path-id GETs (plans_get, payments_get, …) take no account parameter, so
	 * input-side binding cannot scope them: with a multi-business credential a
	 * bound connection could read another business's records by id. A fetched
	 * record's top-level company_id/account_id names its owner — reject it
	 * when it isn't the bound account. parent_company_id is deliberately not
	 * checked: a child-owned record legitimately names its parent there.
	 */
	private enforceResponseOwnership(
		operation: OperationDef,
		body: unknown,
		principal: PrincipalContext,
		requestId: string | undefined,
	): void {
		const bound = principal.accountId;
		if (!bound || operation.method !== "get") return;
		if (body === null || typeof body !== "object" || Array.isArray(body)) {
			return;
		}
		for (const field of ["company_id", "account_id"]) {
			const owner = (body as Record<string, unknown>)[field];
			if (
				typeof owner === "string" &&
				owner.startsWith("biz_") &&
				owner !== bound
			) {
				throw new WhopMcpError(
					"account_mismatch",
					`This connection is bound to account ${bound}; the requested resource belongs to ${owner}.`,
					{ requestId },
				);
			}
		}
	}

	private buildUrl(
		operation: OperationDef,
		args: Record<string, unknown>,
	): string {
		let path = operation.path;
		for (const param of operation.parameters) {
			if (param.in !== "path") continue;
			const value = args[param.name];
			if (value === undefined || value === null) {
				throw new WhopMcpError(
					"invalid_input",
					`Missing required path parameter "${param.name}".`,
				);
			}
			const raw = String(value);
			if (!SAFE_PATH_VALUE.test(raw)) {
				throw new WhopMcpError(
					"invalid_input",
					`Path parameter "${param.name}" contains unsupported characters.`,
				);
			}
			path = path.replace(`{${param.name}}`, encodeURIComponent(raw));
		}

		if (/[{}]/.test(path)) {
			throw new WhopMcpError(
				"internal_error",
				`Unresolved path template for ${operation.toolName}.`,
			);
		}

		const url = new URL(`${this.options.baseUrl.replace(/\/$/, "")}${path}`);
		for (const param of operation.parameters) {
			if (param.in !== "query") continue;
			this.appendQueryParameter(url.searchParams, param.name, args[param.name]);
		}
		return url.toString();
	}

	private appendQueryParameter(
		query: URLSearchParams,
		name: string,
		value: unknown,
	): void {
		if (value === undefined || value === null) return;
		if (Array.isArray(value)) {
			for (const item of value) {
				this.appendQueryParameter(query, `${name}[]`, item);
			}
		} else if (typeof value === "object") {
			for (const [key, entry] of Object.entries(value)) {
				if (key.includes("[") || key.includes("]")) {
					throw new WhopMcpError(
						"invalid_input",
						`Query parameter "${name}" contains a key with unsupported brackets.`,
					);
				}
				this.appendQueryParameter(query, `${name}[${key}]`, entry);
			}
		} else {
			query.append(name, String(value));
		}
	}

	private buildBody(
		operation: OperationDef,
		args: Record<string, unknown>,
	): Record<string, unknown> | undefined {
		if (!operation.hasRequestBody) return undefined;
		const consumed = new Set(operation.parameters.map((p) => p.name));
		const bodyProperties = new Set(operation.bodyProperties);
		const body: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(args)) {
			if (value === undefined) continue;
			// A name consumed by a path/query parameter still lands in the body
			// when the body schema declares it too (e.g. POST /affiliates/{id}/overrides
			// requires `id` in both the path and the body).
			if (consumed.has(key) && !bodyProperties.has(key)) continue;
			body[key] = value;
		}
		return body;
	}
}
