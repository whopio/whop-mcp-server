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
const SECRET = "test-secret-key-that-is-long-enough";

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
		confirmationSecret: SECRET,
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
			confirmationSecret: SECRET,
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
			confirmationSecret: SECRET,
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
});
