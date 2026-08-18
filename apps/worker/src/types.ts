import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { IdempotencyDO } from "./idempotency-do.ts";
import type { SseSessionDO } from "./sse-session-do.ts";

/**
 * Everything the MCP handler needs per grant. Stored end-to-end encrypted by
 * workers-oauth-provider (per-grant key derived from the token), so the Whop
 * tokens are unreadable at rest without a valid MCP token.
 */
export interface WhopGrantProps extends Record<string, unknown> {
	userId: string;
	userName: string | null;
	mcpClientName?: string;
	profile: string;
	whopAccessToken: string;
	whopRefreshToken: string;
	whopExpiresAt: number;
}

export interface Env {
	OAUTH_KV: KVNamespace;
	IDEMPOTENCY: DurableObjectNamespace<IdempotencyDO>;
	SSE_SESSIONS: DurableObjectNamespace<SseSessionDO>;
	OAUTH_PROVIDER: OAuthHelpers;
	MCP_BASE_URL: string;
	MCP_WHOP_API_ORIGIN: string;
	MCP_WHOP_OAUTH_CLIENT_SECRET: string;
	MCP_CONFIRMATION_SECRET: string;
	MCP_STATE_ENCRYPTION_KEY: string;
	CF_VERSION_METADATA: { id: string };
}
