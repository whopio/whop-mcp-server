import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import {
	codeChallengeS256,
	generateCodeVerifier,
	WHOP_MCP_CLIENT_ID,
	WhopOidcClient,
	WhopOidcError,
} from "./whop-oidc.ts";
import { expandProfileToWhopScopes } from "./profile-scopes.ts";
import { openJson, sealJson } from "./pending-state.ts";
import { registry } from "./registry.ts";
import { errorPage, escapeHtml, htmlResponse, whopLogoSvg } from "./html.ts";
import type { Env, WhopGrantProps } from "./types.ts";

const PENDING_TTL_SECONDS = 600;
const SESSION_COOKIE = "mcp_auth_session";

interface PendingAuthorization {
	authRequest: AuthRequest;
	codeVerifier: string;
	profile: string;
	session: string;
}

function cookieValue(request: Request, cookieName: string): string | null {
	const cookies = request.headers.get("cookie") ?? "";
	for (const pair of cookies.split(";")) {
		const [name, ...rest] = pair.trim().split("=");
		if (name === cookieName) return rest.join("=");
	}
	return null;
}

function setCookie(
	env: Env,
	name: string,
	value: string,
	path: string,
): string {
	const secure = env.MCP_BASE_URL.startsWith("https://") ? "; Secure" : "";
	return `${name}=${value}; HttpOnly; SameSite=Lax; Path=${path}; Max-Age=${PENDING_TTL_SECONDS}${secure}`;
}

function oidcClient(env: Env): WhopOidcClient {
	return new WhopOidcClient({
		apiOrigin: env.MCP_WHOP_API_ORIGIN,
		clientId: WHOP_MCP_CLIENT_ID,
		clientSecret: env.MCP_WHOP_OAUTH_CLIENT_SECRET,
		redirectUri: `${env.MCP_BASE_URL}/callback`,
	});
}

function redirectTarget(redirectUri: string): string {
	try {
		const parsed = new URL(redirectUri);
		return parsed.host || parsed.protocol.replace(/:$/, "");
	} catch {
		return "unparseable";
	}
}

function redirectResponse(location: string): Response {
	return new Response(null, { status: 302, headers: { Location: location } });
}

async function redirectUpstream(
	env: Env,
	authRequest: AuthRequest,
	profile: string,
): Promise<Response> {
	const state = crypto.randomUUID();
	const codeVerifier = generateCodeVerifier();
	// Ties /callback to this browser — state alone lets an attacker complete
	// their own sign-in in a victim's browser, linking the victim's agent to
	// the attacker's account.
	const session = crypto.randomUUID();
	const pending: PendingAuthorization = {
		authRequest,
		codeVerifier,
		profile,
		session,
	};
	await env.OAUTH_KV.put(
		`pending_auth:${state}`,
		await sealJson(env.MCP_STATE_ENCRYPTION_KEY, pending, state),
		{ expirationTtl: PENDING_TTL_SECONDS },
	);

	const url = oidcClient(env).authorizeUrl({
		state,
		codeChallenge: await codeChallengeS256(codeVerifier),
		scopes: expandProfileToWhopScopes(profile, registry.operations),
	});
	return new Response(null, {
		status: 302,
		headers: {
			Location: url,
			"Set-Cookie": setCookie(env, SESSION_COOKIE, session, "/callback"),
		},
	});
}

/**
 * The worker is the authorization server facing dynamically registered MCP
 * clients, while upstream Whop sees only the worker's fixed app identity.
 * Every grant is full access; the user approves on Whop's own OAuth screen.
 */
async function handleAuthorize(request: Request, env: Env): Promise<Response> {
	const authRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
	const client = authRequest.clientId
		? await env.OAUTH_PROVIDER.lookupClient(authRequest.clientId)
		: null;
	if (!client) {
		return errorPage("Unknown OAuth client. Reconnect from your agent.");
	}
	return redirectUpstream(env, authRequest, "admin");
}

async function handleCallback(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	const state = url.searchParams.get("state");
	const code = url.searchParams.get("code");
	const upstreamError = url.searchParams.get("error");
	if (upstreamError) {
		return errorPage(
			url.searchParams.get("error_description") ?? upstreamError,
		);
	}
	if (!state || !code) return errorPage("Missing state or code.");

	const pendingRaw = await env.OAUTH_KV.get(`pending_auth:${state}`);
	if (!pendingRaw) {
		return errorPage("This sign-in attempt expired. Start over.");
	}
	const pending = await openJson<PendingAuthorization>(
		env.MCP_STATE_ENCRYPTION_KEY,
		pendingRaw,
		state,
	);
	if (!pending) {
		return errorPage("This sign-in attempt expired. Start over.");
	}
	if (cookieValue(request, SESSION_COOKIE) !== pending.session) {
		return errorPage(
			"This sign-in attempt was started in a different browser. Start over.",
			403,
		);
	}
	await env.OAUTH_KV.delete(`pending_auth:${state}`);

	const client = oidcClient(env);
	const tokens = await client.exchangeCode(code, pending.codeVerifier);
	const userinfo = await client.userinfo(tokens.accessToken);

	// The grant is the user, never a chosen business: context is the agent's
	// per-call choice via each operation's account/user parameters, matching
	// the API's dual-auth model.
	const props: WhopGrantProps = {
		userId: userinfo.sub,
		userName: userinfo.name ?? userinfo.preferred_username ?? null,
		profile: pending.profile,
		whopAccessToken: tokens.accessToken,
		whopRefreshToken: tokens.refreshToken,
		whopExpiresAt: tokens.expiresAt,
	};
	const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
		request: pending.authRequest,
		userId: userinfo.sub,
		metadata: { profile: pending.profile },
		scope: [pending.profile],
		props,
	});
	console.log(
		JSON.stringify({
			type: "mcp_oauth_grant",
			event: "grant_completed",
			userId: userinfo.sub,
			clientId: pending.authRequest.clientId || null,
			profile: pending.profile,
			redirectTarget: redirectTarget(pending.authRequest.redirectUri),
		}),
	);
	return redirectResponse(redirectTo);
}

export const defaultHandler = {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		try {
			// Awaited so rejections reach the catch instead of unhandled 500s.
			if (url.pathname === "/authorize") {
				return await handleAuthorize(request, env);
			}
			if (url.pathname === "/callback") {
				return await handleCallback(request, env);
			}
			if (url.pathname === "/") {
				return htmlResponse(
					`<div class="pane"><div class="brand">${whopLogoSvg(32)}</div><h1>Whop MCP</h1><p>Connect your agent to <code>${escapeHtml(env.MCP_BASE_URL)}/mcp</code>. Authentication runs through your browser — no API keys to copy.</p></div>`,
				);
			}
			return new Response("Not found", { status: 404 });
		} catch (error) {
			console.log(
				JSON.stringify({
					type: "mcp_oauth_error",
					path: url.pathname,
					message: error instanceof Error ? error.message : String(error),
				}),
			);
			if (error instanceof WhopOidcError) {
				return errorPage(error.message, error.status === 401 ? 400 : 502);
			}
			return errorPage("Something went wrong completing the connection.", 500);
		}
	},
};
