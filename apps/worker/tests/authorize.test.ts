import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import { defaultHandler } from "../src/authorize.ts";
import { openJson, sealJson } from "../src/pending-state.ts";
import type { Env } from "../src/types.ts";

const AUTH_REQUEST: AuthRequest = {
	responseType: "code",
	clientId: "agent-client",
	redirectUri: "https://agent.example/callback",
	scope: ["standard"],
	state: "agent-state",
	codeChallenge: "agent-challenge",
	codeChallengeMethod: "S256",
};

afterEach(() => vi.unstubAllGlobals());

function envStub(overrides: Partial<Record<keyof Env, unknown>> = {}): Env {
	return {
		MCP_BASE_URL: "http://localhost:8788",
		MCP_WHOP_API_ORIGIN: "https://api.whop.test",
		MCP_STATE_ENCRYPTION_KEY: "test-state-key-16ch",
		MCP_WHOP_OAUTH_CLIENT_SECRET: "apik_test",
		OAUTH_KV: {
			get: async () => null,
			put: async () => undefined,
			delete: async () => undefined,
		},
		...overrides,
	} as Env;
}

describe("defaultHandler error containment", () => {
	it("renders an error page when the OAuth flow throws, instead of a 500 stack trace", async () => {
		const env = envStub({
			OAUTH_KV: {
				get: async () => {
					throw new Error("KV unavailable");
				},
			},
		});
		const response = await defaultHandler.fetch(
			new Request("http://localhost:8788/callback?state=s&code=c"),
			env,
		);
		expect(response.status).toBe(500);
		expect(response.headers.get("Content-Type")).toContain("text/html");
		const body = await response.text();
		expect(body).toContain("Connection failed");
		expect(body).not.toContain("KV unavailable");
	});

	it("shows the upstream error description when Whop denies consent", async () => {
		const response = await defaultHandler.fetch(
			new Request(
				"http://localhost:8788/callback?error=access_denied&error_description=User+cancelled",
			),
			envStub(),
		);
		expect(response.status).toBe(400);
		expect(await response.text()).toContain("User cancelled");
	});

	it("rejects a callback with no state or code", async () => {
		const response = await defaultHandler.fetch(
			new Request("http://localhost:8788/callback"),
			envStub(),
		);
		expect(response.status).toBe(400);
	});

	it("rejects other browsers without consuming the pending callback", async () => {
		const sealed = await sealJson(
			"test-state-key-16ch",
			{
				authRequest: {},
				codeVerifier: "cv",
				profile: "admin",
				session: "session-of-the-real-browser",
			},
			"s",
		);
		let pendingDeletes = 0;
		const env = envStub({
			OAUTH_KV: {
				get: async () => sealed,
				delete: async () => {
					pendingDeletes += 1;
				},
			},
		});
		for (const cookie of [undefined, "mcp_auth_session=another-browser"]) {
			const response = await defaultHandler.fetch(
				new Request("http://localhost:8788/callback?state=s&code=c", {
					headers: cookie ? { Cookie: cookie } : undefined,
				}),
				env,
			);
			expect(response.status).toBe(403);
			expect(await response.text()).toContain("different browser");
		}
		expect(pendingDeletes).toBe(0);
	});

	it("treats an expired or unknown state as a restartable failure", async () => {
		const response = await defaultHandler.fetch(
			new Request("http://localhost:8788/callback?state=unknown&code=c"),
			envStub(),
		);
		expect(response.status).toBe(400);
		expect(await response.text()).toContain("Start over");
	});

	it("redirects a completed grant to a validated custom-scheme URI", async () => {
		const state = "custom-scheme-state";
		const session = "custom-scheme-session";
		const redirectUri = "custom-agent:/oauth/callback";
		const redirectTo = "custom-agent:/oauth/callback?code=mcp-code";
		let pendingDeletes = 0;
		const sealed = await sealJson(
			"test-state-key-16ch",
			{
				authRequest: { ...AUTH_REQUEST, redirectUri },
				codeVerifier: "code-verifier",
				profile: "standard",
				session,
			},
			state,
		);
		vi.stubGlobal("fetch", async (input: string | URL | Request) => {
			const url = new URL(
				input instanceof Request ? input.url : input.toString(),
			);
			if (url.pathname === "/oauth/token") {
				return Response.json({
					access_token: "access-token",
					refresh_token: "refresh-token",
					expires_in: 3600,
				});
			}
			if (url.pathname === "/oauth/userinfo") {
				return Response.json({ sub: "user_test" });
			}
			throw new Error(`Unexpected fetch: ${url}`);
		});
		const response = await defaultHandler.fetch(
			new Request(
				`http://localhost:8788/callback?state=${state}&code=upstream-code`,
				{ headers: { Cookie: `mcp_auth_session=${session}` } },
			),
			envStub({
				OAUTH_KV: {
					get: async () => sealed,
					delete: async () => {
						pendingDeletes += 1;
					},
				},
				OAUTH_PROVIDER: {
					completeAuthorization: async () => ({ redirectTo }),
				},
			}),
		);

		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe(redirectTo);
		expect(pendingDeletes).toBe(1);
	});
});

describe("OAuth authorize", () => {
	it("redirects straight upstream with a full-access grant", async () => {
		let pendingKey = "";
		let pendingValue = "";
		const env = envStub({
			OAUTH_PROVIDER: {
				parseAuthRequest: async () => AUTH_REQUEST,
				lookupClient: async () => ({
					clientId: AUTH_REQUEST.clientId,
					clientName: "Test agent",
					redirectUris: [AUTH_REQUEST.redirectUri],
				}),
			},
			OAUTH_KV: {
				put: async (key: string, value: string) => {
					pendingKey = key;
					pendingValue = value;
				},
			},
		});
		const response = await defaultHandler.fetch(
			new Request("http://localhost:8788/authorize"),
			env,
		);

		expect(response.status).toBe(302);
		expect(response.headers.get("Set-Cookie")).toMatch(
			/^mcp_auth_session=.+; HttpOnly; SameSite=Lax; Path=\/callback; Max-Age=600$/,
		);
		const location = new URL(response.headers.get("Location") ?? "");
		expect(location.origin).toBe("https://api.whop.test");
		expect(location.searchParams.get("client_id")).toBe("app_3bVb7SdAznaxnW");
		expect(location.searchParams.get("scope")).toContain(
			"payout:withdraw_funds",
		);
		const state = location.searchParams.get("state") ?? "";
		expect(pendingKey).toBe(`pending_auth:${state}`);
		const pending = await openJson<{ profile: string }>(
			"test-state-key-16ch",
			pendingValue,
			state,
		);
		expect(pending?.profile).toBe("admin");
	});

	it("grants full access even when the client requests a narrower profile", async () => {
		let pendingValue = "";
		const env = envStub({
			OAUTH_PROVIDER: {
				parseAuthRequest: async () => ({
					...AUTH_REQUEST,
					scope: ["read_only"],
				}),
				lookupClient: async () => ({
					clientId: AUTH_REQUEST.clientId,
					clientName: "Test agent",
					redirectUris: [AUTH_REQUEST.redirectUri],
				}),
			},
			OAUTH_KV: {
				put: async (_key: string, value: string) => {
					pendingValue = value;
				},
			},
		});
		const response = await defaultHandler.fetch(
			new Request("http://localhost:8788/authorize"),
			env,
		);

		expect(response.status).toBe(302);
		const location = new URL(response.headers.get("Location") ?? "");
		const state = location.searchParams.get("state") ?? "";
		const pending = await openJson<{ profile: string }>(
			"test-state-key-16ch",
			pendingValue,
			state,
		);
		expect(pending?.profile).toBe("admin");
	});

	it("rejects an unknown OAuth client without redirecting upstream", async () => {
		let pendingWrites = 0;
		const env = envStub({
			OAUTH_PROVIDER: {
				parseAuthRequest: async () => AUTH_REQUEST,
				lookupClient: async () => null,
			},
			OAUTH_KV: {
				put: async () => {
					pendingWrites += 1;
				},
			},
		});
		const response = await defaultHandler.fetch(
			new Request("http://localhost:8788/authorize"),
			env,
		);

		expect(response.status).toBe(400);
		expect(await response.text()).toContain("Unknown OAuth client");
		expect(pendingWrites).toBe(0);
	});
});
