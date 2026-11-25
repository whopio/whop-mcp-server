import type { OperationDef } from "../registry/types.ts";

export type WhopMcpErrorCode =
	| "invalid_input"
	| "not_authenticated"
	| "missing_scope"
	| "account_mismatch"
	| "account_required"
	| "confirmation_invalid"
	| "not_found"
	| "conflict"
	| "rate_limited"
	| "upstream_unavailable"
	| "upstream_error"
	| "timeout"
	| "response_too_large"
	| "tool_not_found"
	| "internal_error";

export class WhopMcpError extends Error {
	readonly code: WhopMcpErrorCode;
	readonly status?: number;
	readonly requestId?: string;
	readonly details?: unknown;
	/** True when repeating the same call later may succeed. */
	readonly retryable: boolean;

	constructor(
		code: WhopMcpErrorCode,
		message: string,
		options: {
			status?: number;
			requestId?: string;
			details?: unknown;
			retryable?: boolean;
		} = {},
	) {
		super(message);
		this.name = "WhopMcpError";
		this.code = code;
		this.status = options.status;
		this.requestId = options.requestId;
		this.details = options.details;
		this.retryable = options.retryable ?? false;
	}

	toResult(): Record<string, unknown> {
		return {
			error: {
				code: this.code,
				message: this.message,
				...(this.status !== undefined ? { status: this.status } : {}),
				...(this.retryable ? { retryable: true } : {}),
				...(this.requestId ? { request_id: this.requestId } : {}),
				...(this.details !== undefined ? { details: this.details } : {}),
			},
		};
	}
}

const BEARER_PATTERN = /Bearer\s+[A-Za-z0-9._~+/=-]+/g;
const KEY_PATTERN = /\b(?:apik|sk|whsec|rt|at)_[A-Za-z0-9]{8,}\b/g;

export function redactText(text: string): string {
	return text
		.replace(BEARER_PATTERN, "Bearer [redacted]")
		.replace(KEY_PATTERN, "[redacted]");
}

const SAFE_UPSTREAM_FIELDS = ["type", "code", "message", "param", "detail"];

/**
 * Normalizes an upstream API error body into a safe shape. Raw upstream
 * bodies are never forwarded — only a fixed set of fields survive, and each
 * surviving string is scrubbed of bearer tokens and key material.
 */
export function normalizeUpstreamError(
	status: number,
	body: unknown,
	requestId: string | undefined,
): WhopMcpError {
	let message = `Whop API request failed with status ${status}`;
	let details: Record<string, unknown> | undefined;

	if (body !== null && typeof body === "object") {
		const error = (body as Record<string, unknown>).error;
		if (error !== null && typeof error === "object") {
			details = {};
			for (const field of SAFE_UPSTREAM_FIELDS) {
				const value = (error as Record<string, unknown>)[field];
				if (typeof value === "string") details[field] = redactText(value);
			}
			if (typeof details.message === "string") {
				message = details.message;
			}
		}
	}

	const code = upstreamErrorCode(status);

	return new WhopMcpError(code, message, {
		status,
		requestId,
		details,
		retryable: code === "rate_limited" || code === "upstream_unavailable",
	});
}

/** Maps an upstream HTTP status to a stable code agents can branch on. */
function upstreamErrorCode(status: number): WhopMcpErrorCode {
	if (status === 401) return "not_authenticated";
	if (status === 403) return "missing_scope";
	if (status === 400 || status === 422) return "invalid_input";
	if (status === 404) return "not_found";
	if (status === 409) return "conflict";
	if (status === 429) return "rate_limited";
	if (status >= 500) return "upstream_unavailable";
	return "upstream_error";
}

/**
 * Adds the matching list tool to a 404 on a by-id operation, so an agent
 * knows where to find a valid id. The list operation is the GET on the
 * innermost collection path, e.g. /ad_campaigns/{id} -> GET /ad_campaigns
 * and /affiliates/{id}/overrides/{override_id} -> GET /affiliates/{id}/overrides.
 */
export function withNotFoundHint(
	error: WhopMcpError,
	operation: OperationDef,
	operations: readonly OperationDef[],
): WhopMcpError {
	if (error.code !== "not_found") return error;
	const index = operation.path.lastIndexOf("/{");
	if (index === -1) return error;
	const collection = operation.path.slice(0, index);
	const list = operations.find(
		(op) => op.method === "get" && op.path === collection,
	);
	if (!list) return error;
	const needs = [
		...(list.requiresAccount && list.accountParam ? [list.accountParam] : []),
		...(list.inputSchema.required ?? []),
	];
	const hint = `Find valid ids with ${list.toolName}${needs.length ? ` (needs ${needs.join(", ")})` : ""}.`;
	return new WhopMcpError("not_found", `${error.message} ${hint}`, {
		status: error.status,
		requestId: error.requestId,
		details: error.details,
	});
}
