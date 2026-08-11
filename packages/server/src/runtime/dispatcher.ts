import type { OperationDef } from "../registry/types.ts";
import type { CredentialAdapter, PrincipalContext } from "../policy/types.ts";
import { enforceAccountBinding } from "../policy/account-binding.ts";
import { normalizeUpstreamError, redactValue, WhopMcpError } from "./errors.ts";
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
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESPONSE_BYTES = 512_000;

function bodyPropertyNames(operation: OperationDef): Set<string> {
	const names = new Set<string>();
	const schema = operation.bodySchema;
	if (!schema) return names;
	for (const variant of schema.oneOf ?? schema.anyOf ?? [schema]) {
		for (const name of Object.keys(variant.properties ?? {})) {
			names.add(name);
		}
	}
	return names;
}

/** Path values must be a single, plain segment — no traversal, no separators. */
const SAFE_PATH_VALUE = /^[A-Za-z0-9][A-Za-z0-9._@-]*$/;

export class Dispatcher {
	private readonly options: DispatcherOptions;

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

	async dispatch(
		operation: OperationDef,
		rawArgs: Record<string, unknown>,
		principal: PrincipalContext,
		overrides: DispatchOverrides = {},
	): Promise<{ status: number; requestId?: string; body: unknown }> {
		const args = this.validate(operation, rawArgs, principal);

		const url = this.buildUrl(operation, args);
		const body = this.buildBody(operation, args);

		const { token } = await this.options.credentialAdapter.getCredential();

		// An explicit override is always honored — even for operations whose
		// idempotency policy is "none" — because the API accepts Idempotency-Key
		// on every authenticated POST and a released-for-retry confirmation must
		// never be able to double-execute.
		const idempotencyKey =
			overrides.idempotencyKey ??
			(operation.safety.idempotency !== "none"
				? crypto.randomUUID()
				: undefined);

		const controller = new AbortController();
		const timeout = setTimeout(
			() => controller.abort(),
			this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
		);

		let response: Response;
		try {
			response = await (this.options.fetch ?? fetch)(url, {
				method: operation.method.toUpperCase(),
				headers: {
					Authorization: `Bearer ${token}`,
					"Api-Version-Date": this.options.apiVersionDate,
					...(body !== undefined ? { "Content-Type": "application/json" } : {}),
					...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
					...(this.options.userAgent
						? { "User-Agent": this.options.userAgent }
						: {}),
					...this.options.extraHeaders,
				},
				body: body !== undefined ? JSON.stringify(body) : undefined,
				signal: controller.signal,
			});
		} catch (cause) {
			clearTimeout(timeout);
			if (controller.signal.aborted) {
				throw new WhopMcpError(
					"timeout",
					`${operation.toolName} timed out after ${this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms.`,
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

		// The abort timer stays armed through the body read so a slow-trickling
		// response cannot hang the tool call past the deadline.
		let text: string;
		try {
			text = await response.text();
		} catch (cause) {
			if (controller.signal.aborted) {
				throw new WhopMcpError(
					"timeout",
					`${operation.toolName} timed out after ${this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms while reading the response.`,
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
				`${operation.toolName} returned ${text.length} characters (limit ${maxBytes}). Narrow the request with filters or pagination.`,
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

		this.enforceResponseOwnership(operation, parsed, principal, requestId);

		return {
			status: response.status,
			requestId,
			body: redactValue(parsed),
		};
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
			const expectedPrefix = operation.idPrefixes?.[param.name];
			if (expectedPrefix && !raw.startsWith(`${expectedPrefix}_`)) {
				throw new WhopMcpError(
					"invalid_input",
					`Path parameter "${param.name}" should be a ${expectedPrefix}_… ID, got "${raw}".`,
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
			const value = args[param.name];
			if (value === undefined || value === null) continue;
			if (Array.isArray(value)) {
				for (const item of value) {
					url.searchParams.append(`${param.name}[]`, String(item));
				}
			} else {
				url.searchParams.set(param.name, String(value));
			}
		}
		return url.toString();
	}

	private buildBody(
		operation: OperationDef,
		args: Record<string, unknown>,
	): Record<string, unknown> | undefined {
		if (!operation.hasRequestBody) return undefined;
		const consumed = new Set(operation.parameters.map((p) => p.name));
		const bodyProperties = bodyPropertyNames(operation);
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
