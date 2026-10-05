import { afterEach, describe, expect, it, vi } from "vitest";
import {
	codeChallengeS256,
	generateCodeVerifier,
	WhopOidcClient,
	WhopOidcError,
} from "../src/whop-oidc.ts";

const mcpClient = {
	client_id: "agent-client",
	client_name: "Test agent",
	redirect_uri: "https://agent.example/callback",
};

const client = new WhopOidcClient({
	apiOrigin: "https://api.whop.test",
	clientId: "app_test123",
	clientSecret: "secret_test",
	redirectUri: "https://mcp.whop.test/callback",
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("authorize URL", () => {
	it("carries PKCE S256, state, and the requested scopes", async () => {
		const verifier = generateCodeVerifier();
		const url = new URL(
			client.authorizeUrl({
				state: "state-1",
				codeChallenge: await codeChallengeS256(verifier),
				scopes: ["openid", "payment:basic:read"],
				mcpClient,
			}),
		);
		expect(url.origin).toBe("https://api.whop.test");
		expect(url.pathname).toBe("/oauth/authorize");
		expect(url.searchParams.get("response_type")).toBe("code");
		expect(url.searchParams.get("client_id")).toBe("app_test123");
		expect(url.searchParams.get("code_challenge_method")).toBe("S256");
		expect(url.searchParams.get("code_challenge")).toMatch(/^[\w-]{43}$/);
		expect(url.searchParams.get("scope")).toBe("openid payment:basic:read");
		expect(url.searchParams.get("state")).toBe("state-1");
		expect(url.searchParams.get("nonce")).toBeTruthy();
		expect(JSON.parse(url.searchParams.get("mcp_client")!)).toEqual(mcpClient);
	});

	it("derives the RFC 7636 S256 challenge from the verifier", async () => {
		// Appendix B test vector from RFC 7636.
		expect(
			await codeChallengeS256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
		).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
	});
});

describe("userinfo", () => {
	it("handles redirects manually so the access token stays on the configured origin", async () => {
		let redirect: RequestInit["redirect"];
		vi.stubGlobal("fetch", async (_url: URL | string, init?: RequestInit) => {
			redirect = init?.redirect;
			return Response.json({ sub: "user_1" });
		});

		await expect(client.userinfo("at_1")).resolves.toEqual({ sub: "user_1" });
		expect(redirect).toBe("manual");
	});

	it("rejects redirect responses", async () => {
		vi.stubGlobal(
			"fetch",
			async () =>
				new Response(null, {
					status: 302,
					headers: { Location: "https://attacker.test/userinfo" },
				}),
		);

		await expect(client.userinfo("at_1")).rejects.toMatchObject({
			message: "userinfo failed with 302",
			status: 502,
		});
	});
});

describe("token exchange", () => {
	it("sends the verifier and parses tokens", async () => {
		const calls: {
			url: string;
			body: string;
			redirect?: RequestInit["redirect"];
		}[] = [];
		vi.stubGlobal("fetch", async (url: URL | string, init?: RequestInit) => {
			calls.push({
				url: String(url),
				body: String(init?.body),
				redirect: init?.redirect,
			});
			return Response.json({
				scope: "openid profile",
				access_token: "at_1",
				mcp_client: mcpClient,
				refresh_token: "rt_1",
				expires_in: 900,
			});
		});

		const tokens = await client.exchangeCode("code-1", "verifier-1", mcpClient);
		expect(tokens.accessToken).toBe("at_1");
		expect(tokens.refreshToken).toBe("rt_1");
		expect(tokens.expiresAt).toBeGreaterThan(Date.now());
		expect(calls[0].url).toBe("https://api.whop.test/oauth/token");
		expect(calls[0].redirect).toBe("manual");
		const body = new URLSearchParams(calls[0].body);
		expect(body.get("grant_type")).toBe("authorization_code");
		expect(body.get("code_verifier")).toBe("verifier-1");
		expect(body.get("client_secret")).toBe("secret_test");
	});

	it("rejects redirect responses", async () => {
		vi.stubGlobal(
			"fetch",
			async () =>
				new Response(null, {
					status: 307,
					headers: { Location: "https://attacker.test/token" },
				}),
		);

		await expect(
			client.exchangeCode("code-1", "verifier-1", mcpClient),
		).rejects.toMatchObject({
			message: "Whop token endpoint returned 307: unknown",
			status: 502,
		});
	});

	it("maps upstream 400/401 to a 401 and other failures to 502", async () => {
		vi.stubGlobal("fetch", async () =>
			Response.json({ error: "invalid_grant" }, { status: 400 }),
		);
		await expect(
			client.exchangeCode("bad", "v", mcpClient),
		).rejects.toMatchObject({
			status: 401,
		});

		vi.stubGlobal("fetch", async () =>
			Response.json({ error: "oops" }, { status: 500 }),
		);
		await expect(
			client.refresh("rt_dead", "openid profile"),
		).rejects.toBeInstanceOf(WhopOidcError);
	});

	it("rejects token responses without a refresh token", async () => {
		vi.stubGlobal("fetch", async () =>
			Response.json({ access_token: "at_only", expires_in: 900 }),
		);
		await expect(client.exchangeCode("c", "v", mcpClient)).rejects.toThrow(
			/missing refresh_token/,
		);
	});
});

describe("MCP consent binding", () => {
	it.each([
		undefined,
		{ ...mcpClient, client_id: "another-client" },
		{ ...mcpClient, client_name: "Trusted-looking name" },
		{ ...mcpClient, redirect_uri: "https://elsewhere.example/callback" },
	])(
		"refuses missing or substituted client approval: %j",
		async (approvedClient) => {
			vi.stubGlobal("fetch", async () =>
				Response.json({
					scope: "openid profile",
					access_token: "at_1",
					refresh_token: "rt_1",
					expires_in: 900,
					mcp_client: approvedClient,
				}),
			);
			await expect(
				client.exchangeCode("code", "verifier", mcpClient),
			).rejects.toMatchObject({ status: 401 });
		},
	);
});

it("pins upstream refresh to the scopes approved for this connection", async () => {
	const request = vi.fn(async (_url: URL, _init: RequestInit) =>
		Response.json({
			access_token: "at",
			refresh_token: "rt",
			scope: "openid profile",
		}),
	);
	vi.stubGlobal("fetch", request);
	await client.refresh("rt_old", "openid profile");
	const init = request.mock.calls[0][1];
	expect(new URLSearchParams(String(init.body)).get("scope")).toBe(
		"openid profile",
	);
});
