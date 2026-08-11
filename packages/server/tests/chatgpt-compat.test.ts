import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createWhopMcpServer } from "../src/runtime/server.ts";
import {
	buildRealRegistry,
	fakeFetch,
	principalFixture,
	staticCredential,
} from "./helpers.ts";

const registry = buildRealRegistry();
const SECRET = "test-secret-key-that-is-long-enough";

async function connect(options: { fetch?: typeof fetch } = {}) {
	const { server } = createWhopMcpServer({
		registry,
		credentialAdapter: staticCredential(),
		principal: principalFixture(),
		confirmationSecret: SECRET,
		fetch: options.fetch ?? fakeFetch().fetch,
		baseUrl: "https://api.whop.test/api/v1",
		chatGptCompat: true,
	});
	const client = new Client({ name: "test-client", version: "1.0.0" });
	const [clientTransport, serverTransport] =
		InMemoryTransport.createLinkedPair();
	await Promise.all([
		server.connect(serverTransport),
		client.connect(clientTransport),
	]);
	return client;
}

function parseResult(result: unknown): Record<string, unknown> {
	const content = (result as { content: { type: string; text: string }[] })
		.content;
	return JSON.parse(content[0].text);
}

describe("ChatGPT compat tools", () => {
	it("lists search and fetch when enabled, and omits them by default", async () => {
		const withCompat = await connect();
		const tools = (await withCompat.listTools()).tools.map((t) => t.name);
		expect(tools).toContain("search");
		expect(tools).toContain("fetch");

		const { server } = createWhopMcpServer({
			registry,
			credentialAdapter: staticCredential(),
			principal: principalFixture(),
			confirmationSecret: SECRET,
			fetch: fakeFetch().fetch,
		});
		const client = new Client({ name: "t", version: "1.0.0" });
		const [ct, st] = InMemoryTransport.createLinkedPair();
		await Promise.all([server.connect(st), client.connect(ct)]);
		const defaults = (await client.listTools()).tools.map((t) => t.name);
		expect(defaults).not.toContain("search");
		expect(defaults).not.toContain("fetch");
	});

	it("searches list endpoints and filters by keyword", async () => {
		const { fetch } = fakeFetch((request) => ({
			body: {
				data: request.url.includes("/products")
					? [
							{ id: "prod_alpha1", title: "Alpha Course" },
							{ id: "prod_beta22", title: "Beta Club" },
						]
					: [],
			},
		}));
		const client = await connect({ fetch });
		const result = parseResult(
			await client.callTool({ name: "search", arguments: { query: "alpha" } }),
		);
		const results = result.results as { id: string; title: string }[];
		expect(results.some((r) => r.id === "prod_alpha1")).toBe(true);
		expect(results.some((r) => r.id === "prod_beta22")).toBe(false);
	});

	it("fetches one record by prefixed id and rejects unknown prefixes", async () => {
		const { fetch, requests } = fakeFetch(() => ({
			body: { id: "plan_x1", price: 500 },
		}));
		const client = await connect({ fetch });
		const fetched = parseResult(
			await client.callTool({ name: "fetch", arguments: { id: "plan_x1" } }),
		);
		expect(fetched.id).toBe("plan_x1");
		expect(String(fetched.text)).toContain("500");
		expect(requests[0].url).toContain("/plans/plan_x1");

		const bad = await client.callTool({
			name: "fetch",
			arguments: { id: "zz_nope" },
		});
		expect(bad.isError).toBe(true);
	});

	it("fetches member ids returned by search (mber_ prefix)", async () => {
		const { fetch, requests } = fakeFetch(() => ({
			body: { id: "mber_x1", name: "Sam" },
		}));
		const client = await connect({ fetch });
		const fetched = parseResult(
			await client.callTool({ name: "fetch", arguments: { id: "mber_x1" } }),
		);
		expect(fetched.id).toBe("mber_x1");
		expect(requests[0].url).toContain("/members/mber_x1");
	});
});
