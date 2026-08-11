export type WhopMcpErrorCode =
	| "invalid_input"
	| "not_authenticated"
	| "missing_scope"
	| "account_mismatch"
	| "account_required"
	| "confirmation_required"
	| "confirmation_invalid"
	| "idempotency_conflict"
	| "outcome_unknown"
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

	constructor(
		code: WhopMcpErrorCode,
		message: string,
		options: { status?: number; requestId?: string; details?: unknown } = {},
	) {
		super(message);
		this.name = "WhopMcpError";
		this.code = code;
		this.status = options.status;
		this.requestId = options.requestId;
		this.details = options.details;
	}

	toResult(): Record<string, unknown> {
		return {
			error: {
				code: this.code,
				message: this.message,
				...(this.status !== undefined ? { status: this.status } : {}),
				...(this.requestId ? { request_id: this.requestId } : {}),
				...(this.details !== undefined ? { details: this.details } : {}),
			},
		};
	}
}

const SENSITIVE_KEY_PATTERN =
	/token|secret|password|api_key|apikey|authorization|credential|card_number|cvv|cvc|ssn/i;

const BEARER_PATTERN = /Bearer\s+[A-Za-z0-9._~+/=-]+/g;
const KEY_PATTERN = /\b(?:apik|sk|whsec|rt|at)_[A-Za-z0-9]{8,}\b/g;

export function redactText(text: string): string {
	return text
		.replace(BEARER_PATTERN, "Bearer [redacted]")
		.replace(KEY_PATTERN, "[redacted]");
}

export function redactValue(value: unknown): unknown {
	if (typeof value === "string") return redactText(value);
	if (Array.isArray(value)) return value.map(redactValue);
	if (value !== null && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [key, entry] of Object.entries(value)) {
			out[key] = SENSITIVE_KEY_PATTERN.test(key)
				? "[redacted]"
				: redactValue(entry);
		}
		return out;
	}
	return value;
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

	const code =
		status === 401
			? "not_authenticated"
			: status === 403
				? "missing_scope"
				: "upstream_error";

	return new WhopMcpError(code, message, { status, requestId, details });
}
