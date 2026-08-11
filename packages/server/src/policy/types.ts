import type { PrincipalType } from "../registry/types.ts";

/**
 * Resolves the downstream Whop API credential for the current connection.
 * Hosted deployments exchange the inbound MCP access token server-side; the
 * stdio adapter resolves from CLI profiles or WHOP_API_KEY. The token never
 * appears in model-visible output.
 */
export interface CredentialAdapter {
	getCredential(): Promise<{ token: string }>;
}

/**
 * The trusted, user-approved connection context. Account selection happens in
 * the OAuth consent flow (hosted) or CLI profile (local) — never by the model.
 */
export interface PrincipalContext {
	principalType: PrincipalType;
	userId?: string;
	userName?: string;
	/** The single account (biz_…) this connection is bound to, if any. */
	accountId: string | null;
	accountTitle?: string;
	scopes: string[];
	permissionProfile: string;
}
