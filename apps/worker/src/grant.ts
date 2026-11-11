import type {
	AuditEvent,
	AuditSink,
	CredentialAdapter,
	PrincipalContext,
} from "@whop/mcp-server";
import type { Env, WhopGrantProps } from "./types.ts";

export const EXPIRY_SLACK_MS = 30_000;

export const MUSE_ROUTE = "/muse/mcp";
export const CHATGPT_ROUTE = "/chatgpt/mcp";

/**
 * Profiles on grants issued for one directory route. They run as admin, and
 * their Whop credential holds only the scopes that route's tools declare.
 */
export const MUSE_PROFILE = "muse";
export const CHATGPT_PROFILE = "chatgpt";
const NARROWED_PROFILES: ReadonlySet<string> = new Set([
	MUSE_PROFILE,
	CHATGPT_PROFILE,
]);

export function normalizeMcpClientName(
	clientName: string | undefined,
): string | undefined {
	return (
		clientName
			?.replace(/[^\x20-\x7E]/g, "")
			.trim()
			.slice(0, 128) || undefined
	);
}

/** Header a Whop plugin sets to declare which client config it ships in. */
export const PLUGIN_SOURCE_HEADER = "x-whop-plugin";

export function readPluginSource(request: Request): string | undefined {
	return normalizeMcpClientName(
		request.headers.get(PLUGIN_SOURCE_HEADER) ?? undefined,
	);
}

export class StructuredLogAuditSink implements AuditSink {
	async record(event: AuditEvent): Promise<void> {
		console.log(JSON.stringify({ type: "mcp_audit", ...event }));
	}
}

export function unauthorized(
	env: Env,
	message: string,
	metadataPath = "",
): Response {
	return new Response(
		JSON.stringify({ error: "invalid_token", error_description: message }),
		{
			status: 401,
			headers: {
				"Content-Type": "application/json",
				// RFC 6750 clients read error="invalid_token" as "refresh, don't
				// re-run the full login".
				"WWW-Authenticate": `Bearer error="invalid_token", error_description="${message}", resource_metadata="${env.MCP_BASE_URL}/.well-known/oauth-protected-resource${metadataPath}"`,
			},
		},
	);
}

// insufficient_scope sends the client through a new sign-in for this route;
// invalid_token would only refresh the same grant, forever.
export function wrongRoute(env: Env, path: string): Response {
	const message =
		"This connection was not authorized for this endpoint. Reconnect.";
	return new Response(
		JSON.stringify({ error: "insufficient_scope", error_description: message }),
		{
			status: 403,
			headers: {
				"Content-Type": "application/json",
				"WWW-Authenticate": `Bearer error="insufficient_scope", error_description="${message}", resource_metadata="${env.MCP_BASE_URL}/.well-known/oauth-protected-resource${path}"`,
			},
		},
	);
}

export function parseGrantProps(value: unknown): WhopGrantProps | null {
	if (value === null || typeof value !== "object") return null;
	const props = value as Record<string, unknown>;
	if (props.consentVersion !== 1) return null;
	if (typeof props.whopScope !== "string" || !props.whopScope.trim())
		return null;
	if (typeof props.userId !== "string") return null;
	if (typeof props.profile !== "string") return null;
	if (typeof props.whopAccessToken !== "string") return null;
	if (typeof props.whopRefreshToken !== "string") return null;
	if (typeof props.whopExpiresAt !== "number") return null;
	if (
		props.mcpClientName !== undefined &&
		typeof props.mcpClientName !== "string"
	)
		return null;
	return props as WhopGrantProps;
}

export function grantedScopes(whopScope: string): string[] {
	return [...new Set(whopScope.split(/\s+/).filter(Boolean))].sort();
}

export function principalFromProps(props: WhopGrantProps): PrincipalContext {
	return {
		principalType: "user",
		userId: props.userId,
		userName: props.userName ?? undefined,
		// Never account-bound — context is the agent's per-call choice
		// (see authorize.ts).
		accountId: null,
		// The scopes Whop actually granted, not the ones requested: a tool whose
		// scope the token lacks would only ever return a 403. Grants issued before
		// a scope joined WHOP_SCOPES, and scopes outside it (ad_pixel:manage), are
		// hidden until the user reconnects.
		scopes: grantedScopes(props.whopScope),
		permissionProfile: NARROWED_PROFILES.has(props.profile)
			? "admin"
			: props.profile,
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
	pluginSource?: string,
): Record<string, string> {
	const headers: Record<string, string> = {
		"x-whop-mcp-client": `whop-mcp-worker/${env.CF_VERSION_METADATA.id}; profile=${props.profile}; transport=http`,
	};
	const clientName = normalizeMcpClientName(props.mcpClientName);
	if (clientName) headers["x-whop-mcp-client-name"] = clientName;
	if (pluginSource) headers["x-whop-mcp-plugin-source"] = pluginSource;
	return headers;
}
