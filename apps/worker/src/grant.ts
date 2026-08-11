import type {
	AuditEvent,
	AuditSink,
	CredentialAdapter,
	PrincipalContext,
} from "@whop/mcp-server";
import type { Env, WhopGrantProps } from "./types.ts";

export const EXPIRY_SLACK_MS = 30_000;

export class StructuredLogAuditSink implements AuditSink {
	async record(event: AuditEvent): Promise<void> {
		console.log(JSON.stringify({ type: "mcp_audit", ...event }));
	}
}

export function unauthorized(env: Env, message: string): Response {
	return new Response(
		JSON.stringify({ error: "invalid_token", error_description: message }),
		{
			status: 401,
			headers: {
				"Content-Type": "application/json",
				// RFC 6750 clients read error="invalid_token" as "refresh, don't
				// re-run the full login".
				"WWW-Authenticate": `Bearer error="invalid_token", error_description="${message}", resource_metadata="${env.MCP_BASE_URL}/.well-known/oauth-protected-resource"`,
			},
		},
	);
}

export function parseGrantProps(value: unknown): WhopGrantProps | null {
	if (value === null || typeof value !== "object") return null;
	const props = value as Record<string, unknown>;
	if (typeof props.userId !== "string") return null;
	if (typeof props.profile !== "string") return null;
	if (typeof props.whopAccessToken !== "string") return null;
	if (typeof props.whopRefreshToken !== "string") return null;
	if (typeof props.whopExpiresAt !== "number") return null;
	return props as WhopGrantProps;
}

export function principalFromProps(props: WhopGrantProps): PrincipalContext {
	return {
		principalType: "user",
		userId: props.userId,
		userName: props.userName ?? undefined,
		// Never account-bound — context is the agent's per-call choice
		// (see authorize.ts).
		accountId: null,
		// Tool exposure is narrowed by the permission profile; the Whop-side
		// scope grant independently bounds what the downstream token can do.
		scopes: ["*"],
		permissionProfile: props.profile,
	};
}

export function credentialAdapterFromProps(
	props: WhopGrantProps,
): CredentialAdapter {
	return {
		async getCredential() {
			return { token: props.whopAccessToken };
		},
	};
}

export function attributionHeaders(
	env: Env,
	props: WhopGrantProps,
	transport: "http" | "sse",
): Record<string, string> {
	return {
		"x-whop-mcp-client": `whop-mcp-worker/${env.CF_VERSION_METADATA.id}; profile=${props.profile}; transport=${transport}`,
	};
}
