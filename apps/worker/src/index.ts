import OAuthProvider, { OAuthError } from "@cloudflare/workers-oauth-provider";
import { defaultHandler } from "./authorize.ts";
import { createMcpApiHandler } from "./mcp-handler.ts";
import { createSseApiHandler } from "./sse-handler.ts";
import {
	WHOP_MCP_CLIENT_ID,
	WhopOidcClient,
	WhopOidcError,
} from "./whop-oidc.ts";
import type { Env, WhopGrantProps } from "./types.ts";

export { IdempotencyDO } from "./idempotency-do.ts";
export { SseSessionDO } from "./sse-session-do.ts";

const REFRESH_AHEAD_MS = 15 * 60 * 1000;

/**
 * tokenExchangeCallback receives only its options object — no Worker
 * bindings — so the fetch wrapper below captures env before delegating to
 * the provider. Bindings are identical for every request in an isolate, so
 * last-write-wins is safe.
 */
let workerEnv: Env | undefined;

/**
 * Rotate the server-side Whop credential whenever the MCP client refreshes
 * its token and the Whop token is near expiry. The MCP access-token TTL is
 * matched to Whop's, so routine expiry always funnels through here — the
 * only place rotated Whop tokens can be persisted back onto the grant.
 */
async function tokenExchangeCallback(options: {
	grantType: string;
	props: WhopGrantProps;
	grantId: string;
	userId: string;
}): Promise<{ newProps?: WhopGrantProps } | undefined> {
	if (options.grantType !== "refresh_token") return undefined;
	const props = options.props;
	if (props.whopExpiresAt > Date.now() + REFRESH_AHEAD_MS) return undefined;

	const env = workerEnv;
	if (!env) {
		throw new Error("Worker env was not captured before token exchange.");
	}
	const client = new WhopOidcClient({
		apiOrigin: env.MCP_WHOP_API_ORIGIN,
		clientId: WHOP_MCP_CLIENT_ID,
		clientSecret: env.MCP_WHOP_OAUTH_CLIENT_SECRET,
		redirectUri: `${env.MCP_BASE_URL}/callback`,
	});
	let tokens;
	try {
		tokens = await client.refresh(props.whopRefreshToken);
	} catch (error) {
		// invalid_grant makes the client discard the connection and
		// re-authorize instead of retrying a dead grant. No upstream revoke:
		// a 401ed refresh token is already unusable, and revoking after losing
		// a concurrent-refresh race could cascade to the winner's session.
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
	return {
		newProps: {
			...props,
			whopAccessToken: tokens.accessToken,
			whopRefreshToken: tokens.refreshToken,
			whopExpiresAt: tokens.expiresAt,
		},
	};
}

const provider = new OAuthProvider({
	apiHandlers: {
		"/mcp": createMcpApiHandler(),
		// Prefix-matched: covers GET /sse and POST /sse/message, and the
		// provider auto-serves the /sse-suffixed protected-resource metadata.
		"/sse": createSseApiHandler(),
	},
	defaultHandler,
	authorizeEndpoint: "/authorize",
	tokenEndpoint: "/token",
	clientRegistrationEndpoint: "/register",
	clientIdMetadataDocumentEnabled: true,
	allowPlainPKCE: false,
	scopesSupported: ["admin"],
	accessTokenTTL: 3600,
	tokenExchangeCallback,
});

export default {
	fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		workerEnv = env;
		// The provider derives issuer/endpoint URLs from the request. Behind a
		// TLS-terminating proxy (local https tunnels; any future LB) the origin
		// hop is plain http — honor the standard header, upgrade-only so a
		// spoofed header can never downgrade a real https request.
		const url = new URL(request.url);
		if (
			url.protocol === "http:" &&
			request.headers.get("x-forwarded-proto") === "https"
		) {
			url.protocol = "https:";
			request = new Request(url.toString(), request);
		}
		return provider.fetch(request, env, ctx);
	},
};
