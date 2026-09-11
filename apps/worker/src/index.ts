import OAuthProvider, {
	getOAuthApi,
	type OAuthProviderOptions,
	type TokenExchangeCallbackOptions,
	type TokenExchangeCallbackResult,
} from "@cloudflare/workers-oauth-provider";
import { defaultHandler } from "./authorize.ts";
import { createMcpApiHandler } from "./mcp-handler.ts";
import { reconcileGrantOnTokenExchange } from "./token-exchange.ts";
import { WHOP_MCP_CLIENT_ID, WhopOidcClient } from "./whop-oidc.ts";
import type { Env } from "./types.ts";

export { IdempotencyDO } from "./idempotency-do.ts";

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
async function tokenExchangeCallback(
	options: TokenExchangeCallbackOptions,
): Promise<TokenExchangeCallbackResult | undefined> {
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
	return reconcileGrantOnTokenExchange(options, {
		lookupClient: (clientId) =>
			getOAuthApi<Env>(providerOptions, env).lookupClient(clientId),
		now: Date.now,
		refreshWhop: (refreshToken) => client.refresh(refreshToken),
	});
}

const providerOptions: OAuthProviderOptions<Env> = {
	apiHandlers: {
		"/mcp": createMcpApiHandler(),
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
};

const provider = new OAuthProvider<Env>(providerOptions);

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
