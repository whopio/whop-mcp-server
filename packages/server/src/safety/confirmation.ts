import { WhopMcpError } from "../runtime/errors.ts";
import type { PrincipalContext } from "../policy/types.ts";

const encoder = new TextEncoder();

function toBase64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary)
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
	const padded = value.replace(/-/g, "+").replace(/_/g, "/");
	const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
	const bytes = new Uint8Array(new ArrayBuffer(binary.length));
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

export function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map(canonicalJson).join(",")}]`;
	}
	if (value !== null && typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>)
			.filter(([, v]) => v !== undefined)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
		return `{${entries.join(",")}}`;
	}
	return JSON.stringify(value);
}

export async function hashArguments(
	args: Record<string, unknown>,
): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		encoder.encode(canonicalJson(args)),
	);
	return toBase64Url(new Uint8Array(digest));
}

export interface ConfirmationPayload {
	jti: string;
	tool: string;
	principal: string;
	account: string;
	argsHash: string;
	exp: number;
}

/**
 * Short-lived confirmation tokens binding a prepared mutation to the exact
 * tool, principal, account, and arguments it was prepared with. HMAC over
 * WebCrypto so the same implementation runs in Node and Cloudflare Workers.
 */
export class ConfirmationSigner {
	private readonly keyPromise: Promise<CryptoKey>;
	private readonly ttlMs: number;
	private readonly now: () => number;

	constructor(
		secret: string,
		options: { ttlMs?: number; now?: () => number } = {},
	) {
		if (secret.length < 16) {
			throw new Error(
				"Confirmation signing secret must be at least 16 characters.",
			);
		}
		this.ttlMs = options.ttlMs ?? 5 * 60 * 1000;
		this.now = options.now ?? Date.now;
		this.keyPromise = crypto.subtle.importKey(
			"raw",
			encoder.encode(secret),
			{ name: "HMAC", hash: "SHA-256" },
			false,
			["sign", "verify"],
		);
	}

	private principalKey(principal: PrincipalContext): string {
		return `${principal.principalType}:${principal.userId ?? "-"}`;
	}

	async issue(
		toolName: string,
		args: Record<string, unknown>,
		principal: PrincipalContext,
	): Promise<{ token: string; expiresAt: string }> {
		const payload: ConfirmationPayload = {
			jti: crypto.randomUUID(),
			tool: toolName,
			principal: this.principalKey(principal),
			account: principal.accountId ?? "-",
			argsHash: await hashArguments(args),
			exp: this.now() + this.ttlMs,
		};
		const body = toBase64Url(encoder.encode(canonicalJson(payload)));
		const signature = await crypto.subtle.sign(
			"HMAC",
			await this.keyPromise,
			encoder.encode(body),
		);
		return {
			token: `${body}.${toBase64Url(new Uint8Array(signature))}`,
			expiresAt: new Date(payload.exp).toISOString(),
		};
	}

	async verify(
		token: string,
		toolName: string,
		args: Record<string, unknown>,
		principal: PrincipalContext,
	): Promise<ConfirmationPayload> {
		const [body, signature] = token.split(".");
		if (!body || !signature) {
			throw new WhopMcpError(
				"confirmation_invalid",
				"Malformed confirmation token.",
			);
		}

		const valid = await crypto.subtle.verify(
			"HMAC",
			await this.keyPromise,
			fromBase64Url(signature),
			encoder.encode(body),
		);
		if (!valid) {
			throw new WhopMcpError(
				"confirmation_invalid",
				"Confirmation token signature is invalid.",
			);
		}

		let payload: ConfirmationPayload;
		try {
			payload = JSON.parse(new TextDecoder().decode(fromBase64Url(body)));
		} catch {
			throw new WhopMcpError(
				"confirmation_invalid",
				"Confirmation token payload is unreadable.",
			);
		}

		if (typeof payload.jti !== "string" || payload.jti.length === 0) {
			throw new WhopMcpError(
				"confirmation_invalid",
				"Confirmation token payload is unreadable.",
			);
		}
		if (payload.exp < this.now()) {
			throw new WhopMcpError(
				"confirmation_invalid",
				"Confirmation token has expired. Prepare the operation again.",
			);
		}
		if (payload.tool !== toolName) {
			throw new WhopMcpError(
				"confirmation_invalid",
				"Confirmation token was issued for a different tool.",
			);
		}
		if (payload.principal !== this.principalKey(principal)) {
			throw new WhopMcpError(
				"confirmation_invalid",
				"Confirmation token was issued for a different principal.",
			);
		}
		if (payload.account !== (principal.accountId ?? "-")) {
			throw new WhopMcpError(
				"confirmation_invalid",
				"Confirmation token was issued for a different account.",
			);
		}
		if (payload.argsHash !== (await hashArguments(args))) {
			throw new WhopMcpError(
				"confirmation_invalid",
				"Arguments changed since the operation was prepared. Prepare it again with the final arguments.",
			);
		}
		return payload;
	}
}
