import {
	Client,
	StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
import {
	createStreamableHttpHandler,
	HttpAuthError,
	type HttpAuthenticator,
} from "../src/adapters/streamable-http.ts";
import {
	buildRealRegistry,
	fakeFetch,
	principalFixture,
	staticCredential,
} from "./helpers.ts";

const registry = buildRealRegistry();

const okAuthenticator: HttpAuthenticator = {
	async authenticate(request) {
		const auth = request.headers.get("Authorization");
		if (auth !== "Bearer valid-mcp-token") {
			throw new HttpAuthError(401, "Invalid or missing access token.", {
				"WWW-Authenticate":
					'Bearer resource_metadata="https://mcp.whop.test/.well-known/oauth-protected-resource"',
			});
		}
		return {
			principal: principalFixture(),
			credentialAdapter: staticCredential(),
			clientName: "test-client",
		};
	},
};

function makeHandler() {
	return createStreamableHttpHandler({
		registry,
		authenticator: okAuthenticator,
		fetch: fakeFetch().fetch,
		allowedOrigins: ["https://claude.ai"],
	});
}

function initializeRequest(headers: Record<string, string> = {}): Request {
	return new Request("https://mcp.whop.test/mcp", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
			Authorization: "Bearer valid-mcp-token",
			...headers,
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: {
				protocolVersion: "2025-03-26",
				capabilities: {},
				clientInfo: { name: "test", version: "1.0" },
			},
		}),
	});
}

describe("streamable HTTP adapter", () => {
	it("authenticates every request and challenges without a token", async () => {
		const handler = makeHandler();
		const request = initializeRequest();
		request.headers.delete("Authorization");
		const response = await handler(request);
		expect(response.status).toBe(401);
		expect(response.headers.get("WWW-Authenticate")).toContain(
			"resource_metadata",
		);
	});

	it("serves initialize as JSON for an authenticated request", async () => {
		const handler = makeHandler();
		const response = await handler(initializeRequest());
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			result: { serverInfo: { name: string }; protocolVersion?: string };
		};
		expect(body.result.serverInfo.name).toBe("whop");
		expect(body.result.protocolVersion).toBeDefined();
	});

	it("rejects disallowed origins", async () => {
		const handler = makeHandler();
		const response = await handler(
			initializeRequest({ Origin: "https://evil.example" }),
		);
		expect(response.status).toBe(403);
	});

	it("allows any origin when no allowlist is configured (bearer auth is the boundary)", async () => {
		const handler = createStreamableHttpHandler({
			registry,
			authenticator: okAuthenticator,
			fetch: fakeFetch().fetch,
		});
		const response = await handler(
			initializeRequest({ Origin: "https://claude.ai" }),
		);
		expect(response.status).toBe(200);
	});

	it("allows configured origins", async () => {
		const handler = makeHandler();
		const response = await handler(
			initializeRequest({ Origin: "https://claude.ai" }),
		);
		expect(response.status).toBe(200);
	});

	it("rejects credentials in query parameters", async () => {
		const handler = makeHandler();
		const response = await handler(
			new Request("https://mcp.whop.test/mcp?access_token=abc", {
				method: "POST",
				headers: { Authorization: "Bearer valid-mcp-token" },
				body: "{}",
			}),
		);
		expect(response.status).toBe(400);
	});

	it("rejects non-POST methods in the stateless adapter", async () => {
		const handler = makeHandler();
		for (const method of ["GET", "DELETE"]) {
			const response = await handler(
				new Request("https://mcp.whop.test/mcp", {
					method,
					headers: { Authorization: "Bearer valid-mcp-token" },
				}),
			);
			expect(response.status).toBe(405);
		}
	});

	it("requires HTTPS when configured", async () => {
		const handler = createStreamableHttpHandler({
			registry,
			authenticator: okAuthenticator,
			requireHttps: true,
		});
		const response = await handler(
			new Request("http://mcp.whop.test/mcp", {
				method: "POST",
				headers: { Authorization: "Bearer valid-mcp-token" },
				body: "{}",
			}),
		);
		expect(response.status).toBe(400);
	});

	it("serves the same tools to a client on the 2026-07-28 revision as to an older one", async () => {
		const handler = makeHandler();
		const connect = async (
			options?: ConstructorParameters<typeof Client>[1],
		) => {
			const client = new Client(
				{ name: "test-client", version: "1.0.0" },
				options,
			);
			await client.connect(
				new StreamableHTTPClientTransport(
					new URL("https://mcp.whop.test/mcp"),
					{
						fetch: (input, init) =>
							handler(
								new Request(input, {
									...init,
									headers: {
										...Object.fromEntries(new Headers(init?.headers)),
										Authorization: "Bearer valid-mcp-token",
									},
								}),
							),
					},
				),
			);
			return client;
		};
		const modern = await connect({
			versionNegotiation: { mode: { pin: "2026-07-28" } },
		});
		const legacy = await connect();
		expect(modern.getNegotiatedProtocolVersion()).toBe("2026-07-28");
		expect(legacy.getNegotiatedProtocolVersion()).toBe("2025-11-25");

		const names = async (client: Client) =>
			(await client.listTools()).tools.map((tool) => tool.name);
		const modernNames = await names(modern);
		expect(modernNames.length).toBeGreaterThan(0);
		expect(modernNames).toEqual(await names(legacy));

		const status = await modern.callTool({
			name: "connection_status",
			arguments: {},
		});
		expect(status.isError).toBeFalsy();
	});

	it("keeps answering initialize from a client on an older revision", async () => {
		const handler = makeHandler();
		const response = await handler(initializeRequest());
		const body = (await response.json()) as {
			result: { protocolVersion: string };
		};
		expect(response.headers.get("Content-Type")).toContain("application/json");
		expect(body.result.protocolVersion).toBe("2025-03-26");
	});

	function modernRequest(method: string, protocolVersion = "2026-07-28") {
		return new Request("https://mcp.whop.test/mcp", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
				Authorization: "Bearer valid-mcp-token",
				"Mcp-Method": method,
				"MCP-Protocol-Version": protocolVersion,
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method,
				params: {
					_meta: {
						"io.modelcontextprotocol/protocolVersion": protocolVersion,
						"io.modelcontextprotocol/clientInfo": {
							name: "test",
							version: "1.0",
						},
						"io.modelcontextprotocol/clientCapabilities": {},
					},
				},
			}),
		});
	}

	it("rejects a subscription stream instead of holding it open", async () => {
		const handler = makeHandler();
		const response = await handler(modernRequest("subscriptions/listen"));
		expect(response.status).toBe(404);
		expect(response.headers.get("Content-Type")).toContain("application/json");
		expect(await response.json()).toEqual({
			jsonrpc: "2.0",
			id: 1,
			error: { code: -32601, message: "Method not found" },
		});
	});

	it("names the supported revision when a client asks for an unknown one", async () => {
		const handler = makeHandler();
		const response = await handler(modernRequest("tools/list", "2099-01-01"));
		expect(response.status).toBe(400);
		const body = (await response.json()) as {
			error: { code: number; data: { supported: string[] } };
		};
		expect(body.error.code).toBe(-32022);
		expect(body.error.data.supported).toEqual(["2026-07-28"]);
	});
});
