import {
	GrantType,
	OAuthError,
	type TokenExchangeCallbackOptions,
	type TokenExchangeCallbackResult,
} from "@cloudflare/workers-oauth-provider";
import { normalizeMcpClientName } from "./grant.ts";
import type { WhopGrantProps } from "./types.ts";
import { WhopOidcError, type WhopTokens } from "./whop-oidc.ts";

const REFRESH_AHEAD_MS = 15 * 60 * 1000;

interface TokenExchangeDependencies {
	lookupClient(clientId: string): Promise<{ clientName?: string } | null>;
	now(): number;
	refreshWhop(refreshToken: string): Promise<WhopTokens>;
}

export async function reconcileGrantOnTokenExchange(
	options: TokenExchangeCallbackOptions,
	dependencies: TokenExchangeDependencies,
): Promise<TokenExchangeCallbackResult | undefined> {
	if (options.grantType !== GrantType.REFRESH_TOKEN) return undefined;
	const props = options.props as WhopGrantProps;
	if (props.whopExpiresAt > dependencies.now() + REFRESH_AHEAD_MS) {
		return undefined;
	}

	let mcpClientName = normalizeMcpClientName(props.mcpClientName);
	if (!mcpClientName) {
		try {
			const client = await dependencies.lookupClient(options.clientId);
			mcpClientName = normalizeMcpClientName(client?.clientName);
		} catch (error) {
			console.warn(
				JSON.stringify({
					type: "mcp_oauth_error",
					event: "client_name_backfill_failed",
					grantId: options.grantId,
					error: error instanceof Error ? error.name : "unknown",
				}),
			);
		}
	}

	let tokens: WhopTokens;
	try {
		tokens = await dependencies.refreshWhop(props.whopRefreshToken);
	} catch (error) {
		if (error instanceof WhopOidcError && error.status === 401) {
			console.log(
				JSON.stringify({
					type: "mcp_oauth_error",
					event: "upstream_refresh_terminal",
					grantId: options.grantId,
				}),
			);
			throw new OAuthError("invalid_grant", {
				description:
					"The connection's Whop credential is no longer valid. Reconnect to re-authorize.",
			});
		}
		throw error;
	}

	const newProps: WhopGrantProps = {
		...props,
		whopAccessToken: tokens.accessToken,
		whopRefreshToken: tokens.refreshToken,
		whopExpiresAt: tokens.expiresAt,
	};
	if (mcpClientName) {
		newProps.mcpClientName = mcpClientName;
	} else {
		delete newProps.mcpClientName;
	}

	if (mcpClientName && !normalizeMcpClientName(props.mcpClientName)) {
		console.log(
			JSON.stringify({
				type: "mcp_oauth_grant",
				event: "client_name_backfilled",
				grantId: options.grantId,
			}),
		);
	}

	return { newProps };
}
