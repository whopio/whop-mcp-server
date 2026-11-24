import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createStreamableHttpHandler } from "../src/adapters/streamable-http.ts";
import { SURFACE_NAMES, type SurfaceName } from "../src/policy/surfaces.ts";
import { FLOWS } from "../src/runtime/flows.ts";
import { GUIDE_PROMPTS } from "../src/runtime/prompts.ts";
import { GUIDE_URIS, readResource } from "../src/runtime/resources.ts";
import { createWhopMcpServer } from "../src/runtime/server.ts";
import { REGISTRY_NAMING } from "../src/runtime/tool-names.ts";
import { toolReach } from "../src/runtime/tool-reach.ts";
import {
	buildRealRegistry,
	fakeFetch,
	principalFixture,
	registryName,
	staticCredential,
} from "./helpers.ts";

const registry = buildRealRegistry();
const userPrincipal = principalFixture({
	principalType: "user",
	accountId: null,
});
const toolNames = registry.operations
	.flatMap((op) => [op.toolName, op.verbName])
	.sort((a, b) => b.length - a.length);
const writes = new Set(
	registry.operations
		.filter((op) => !op.annotations.readOnlyHint)
		.map((op) => op.toolName),
);
const GUIDED_SURFACES = ["muse", "full"] as const;

async function connect(
	options: {
		surface?: SurfaceName;
		promptsAndResources?: boolean;
		principal?: typeof userPrincipal;
	} = {},
) {
	const { server } = createWhopMcpServer({
		registry,
		toolListing: "compact",
		surface: options.surface ?? "muse",
		credentialAdapter: staticCredential(),
		principal: options.principal ?? userPrincipal,
		fetch: fakeFetch().fetch,
		docs: true,
		baseUrl: "https://api.whop.test/api/v1",
		promptsAndResources: options.promptsAndResources ?? true,
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

function textOf(content: { type: string; text?: string } | undefined) {
	return content?.type === "text" ? (content.text ?? "") : "";
}

async function promptText(client: Client, name: string): Promise<string> {
	const guide = GUIDE_PROMPTS.find(
		(candidate) => candidate.prompt.name === name,
	);
	const args = Object.fromEntries(
		(guide?.prompt.arguments ?? []).map((argument) => [argument.name, "x"]),
	);
	const { messages } = await client.getPrompt({ name, arguments: args });
	return textOf(messages[0]?.content as { type: string; text?: string });
}

async function allGuideText(client: Client) {
	const texts: { source: string; text: string }[] = [];
	for (const { name } of (await client.listPrompts()).prompts) {
		texts.push({
			source: `prompt ${name}`,
			text: await promptText(client, name),
		});
	}
	for (const { uri } of (await client.listResources()).resources) {
		const { contents } = await client.readResource({ uri });
		const [content] = contents;
		texts.push({
			source: uri,
			text: content && "text" in content ? content.text : "",
		});
	}
	return texts;
}

function mentions(text: string): { tool: string; after: string }[] {
	const found: { tool: string; after: string }[] = [];
	let rest = text;
	for (const tool of toolNames) {
		const pattern = new RegExp(
			`(?<![\\w-])${tool.replace(/[-]/g, "\\-")}(?![\\w-])`,
			"g",
		);
		for (const match of rest.matchAll(pattern)) {
			const end = match.index + tool.length;
			found.push({
				tool: registryName(tool),
				after: rest.slice(end, end + 40),
			});
		}
		rest = rest.replace(pattern, " ".repeat(tool.length));
	}
	return found;
}

describe("prompts and resources", () => {
	it("declares neither capability unless enabled", async () => {
		for (const surface of SURFACE_NAMES) {
			const client = await connect({ surface, promptsAndResources: false });
			const capabilities = client.getServerCapabilities();
			expect(capabilities?.tools).toBeDefined();
			expect(capabilities?.prompts).toBeUndefined();
			expect(capabilities?.resources).toBeUndefined();
			expect(client.getInstructions()).not.toContain("whop://guides/");
			await expect(client.listPrompts()).rejects.toThrow();
			await expect(client.listResources()).rejects.toThrow();
		}
	});

	it("offers every prompt on Muse and on the full surface", async () => {
		for (const surface of GUIDED_SURFACES) {
			const client = await connect({ surface });
			expect(client.getServerCapabilities()).toMatchObject({
				prompts: {},
				resources: {},
			});
			expect(client.getInstructions()).toContain("whop://guides/finding-tools");
			const { prompts } = await client.listPrompts();
			expect(prompts.map((prompt) => prompt.name)).toEqual(
				GUIDE_PROMPTS.map((guide) => guide.prompt.name),
			);
		}
	});

	it("names exactly a prompt's required tools in its text", async () => {
		for (const surface of GUIDED_SURFACES) {
			const client = await connect({ surface });
			for (const guide of GUIDE_PROMPTS) {
				const text = await promptText(client, guide.prompt.name);
				const named = new Set(mentions(text).map(({ tool }) => tool));
				expect(named, `${surface} ${guide.prompt.name}`).toEqual(
					new Set(guide.requiredTools),
				);
			}
		}
	});

	it("names only tools the connection can call, and says how to run unlisted ones", async () => {
		for (const surface of GUIDED_SURFACES) {
			const client = await connect({ surface });
			const listed = new Set(
				(await client.listTools()).tools.map((tool) => registryName(tool.name)),
			);
			for (const { source, text } of await allGuideText(client)) {
				if (surface === "muse") {
					expect(text, source).not.toContain("call_write_operation");
				}
				for (const { tool, after } of mentions(text)) {
					if (listed.has(tool)) continue;
					const via = writes.has(tool)
						? "call_write_operation"
						: "call_read_operation";
					expect(after, `${surface} ${source}: ${tool}`).toMatch(
						new RegExp(`^\`? \\(through \`?${via}`),
					);
				}
				if (
					source !== "whop://guides/finding-tools" &&
					/\(through `?call_/.test(text)
				) {
					expect(text, source).toContain("describe_operation with its name");
				}
			}
		}
	});

	it("routes unlisted Muse reads through call_read_operation", async () => {
		const client = await connect();
		const text = await promptText(client, "handle_buyer_complaints");
		expect(text).toContain(
			"resolution-center-cases_events (through call_read_operation)",
		);
		const result = await client.callTool({
			name: "describe_operation",
			arguments: { name: "resolution-center-cases_events" },
		});
		expect(result.isError).toBeFalsy();
	});

	it("finds the operations the finding-tools guide's examples name", async () => {
		const examples = {
			"membership details": "memberships_get",
			"case history": "resolution-center-cases_events",
		};
		const client = await connect();
		const { contents } = await client.readResource({
			uri: "whop://guides/finding-tools",
		});
		const guide = contents[0] && "text" in contents[0] ? contents[0].text : "";
		for (const [query, tool] of Object.entries(examples)) {
			expect(guide).toContain(`"${query}"`);
			const result = await client.callTool({
				name: "search_operations",
				arguments: { query, limit: 5 },
			});
			expect(
				textOf((result.content as { type: string; text?: string }[])[0]),
				query,
			).toContain(`"${tool}"`);
		}
	});

	it("asks for a yes before every prompt that changes something", async () => {
		const client = await connect({ surface: "full" });
		for (const guide of GUIDE_PROMPTS) {
			const text = (await promptText(client, guide.prompt.name)).toLowerCase();
			if (guide.requiredTools.some((tool) => writes.has(tool))) {
				expect(text, guide.prompt.name).toContain("wait for my yes");
			} else {
				expect(text, guide.prompt.name).toContain(
					"don't create or change anything.",
				);
			}
		}
	});

	it("shows the amount and asks every time before money goes back", async () => {
		const client = await connect();
		const refund = await promptText(client, "refund_payment");
		expect(refund).toContain("the amount and currency");
		expect(refund).toContain("Wait for my yes every time");
		expect(refund).toMatch(/fails or times out, check refunds_list/);
		const complaints = await promptText(client, "handle_buyer_complaints");
		expect(complaints).toContain("refunds the payment in full");
		expect(complaints).toContain("the amount and currency");
		expect(complaints).toContain("Wait for my yes on every case");
	});

	it("asks for a yes in every guide that names a write", async () => {
		for (const surface of GUIDED_SURFACES) {
			const client = await connect({ surface });
			for (const { source, text } of await allGuideText(client)) {
				if (!source.startsWith("whop://")) continue;
				if (source.endsWith("/finding-tools")) continue;
				if (mentions(text).some(({ tool }) => writes.has(tool))) {
					expect(text, `${surface} ${source}`).toContain("wait for a yes");
				}
			}
		}
	});

	it("serves guides to a sign-in whose scopes hide most tools", async () => {
		const client = await connect({
			principal: { ...userPrincipal, scopes: ["member:basic:read"] },
		});
		const listed = new Set(
			(await client.listTools()).tools.map((tool) => registryName(tool.name)),
		);
		const { prompts } = await client.listPrompts();
		expect(prompts.length).toBeLessThan(GUIDE_PROMPTS.length);
		for (const { name } of prompts) {
			const guide = GUIDE_PROMPTS.find(
				(candidate) => candidate.prompt.name === name,
			);
			for (const tool of guide?.requiredTools ?? []) {
				expect(listed, `${name} needs ${tool}`).toContain(tool);
			}
		}
		const texts = await allGuideText(client);
		expect(texts.length).toBeGreaterThan(0);
	});

	it("never requires a write in a flow that offers choices", () => {
		for (const flow of FLOWS.filter((f) => f.steps.some((s) => s.choice))) {
			for (const step of flow.steps) {
				if (step.tool && writes.has(step.tool)) {
					expect(step.optional, `${flow.title}: ${step.tool}`).toBe(true);
				}
			}
		}
	});

	it("leaves out a flow when none of its choices can run", () => {
		const reach = toolReach(
			[],
			[],
			["memberships_list", "payments_list", "members_list"],
			REGISTRY_NAMING,
		);
		const text = readResource("whop://guides/customers", reach)?.text ?? "";
		expect(text).toContain("## Who churned, and what did they pay?");
		expect(text).not.toContain("## Cancel, pause or resume a membership");
		expect(text).not.toContain("## Handle a buyer complaint");
	});

	it("fills a prompt from its arguments", async () => {
		const client = await connect();
		const result = await client.getPrompt({
			name: "create_product",
			arguments: {
				name: "Dark Chocolate Sampler",
				price: "$24",
				billing: "monthly",
			},
		});
		expect(result.messages).toHaveLength(1);
		const text = textOf(
			result.messages[0]?.content as { type: string; text?: string },
		);
		expect(text).toContain('"Dark Chocolate Sampler"');
		expect(text).toContain("$24 monthly");
		expect(text).toContain("billing_period 30");
		expect(text).toContain("wait for my yes");
	});

	it("rejects a missing required argument, an unknown argument and an unknown prompt", async () => {
		const client = await connect();
		await expect(
			client.getPrompt({
				name: "create_product",
				arguments: { name: "Sampler" },
			}),
		).rejects.toThrow(/needs price/);
		await expect(
			client.getPrompt({
				name: "respond_to_disputes",
				arguments: { status: "won" },
			}),
		).rejects.toThrow(/no argument "status"/);
		await expect(client.getPrompt({ name: "send_payout" })).rejects.toThrow(
			/Unknown prompt/,
		);
	});

	it("lists and reads every guide the connection can use", async () => {
		const expected = {
			muse: GUIDE_URIS.filter((uri) => uri !== "whop://guides/website"),
			full: GUIDE_URIS,
		};
		for (const surface of GUIDED_SURFACES) {
			const client = await connect({ surface });
			const { resources } = await client.listResources();
			expect(resources.map((resource) => resource.uri)).toEqual(
				expected[surface],
			);
			for (const resource of resources) {
				expect(resource).not.toHaveProperty("render");
				const { contents } = await client.readResource({ uri: resource.uri });
				expect(contents).toHaveLength(1);
				expect(contents[0]).toMatchObject({
					uri: resource.uri,
					mimeType: "text/markdown",
				});
				const [content] = contents;
				expect(content && "text" in content ? content.text : "").toMatch(/^# /);
			}
		}
	});

	it("covers every flow whose required tools the connection can call", async () => {
		const client = await connect();
		const text = (await allGuideText(client))
			.map(({ text }) => text)
			.join("\n");
		const titles = FLOWS.filter((flow) => flow.group !== "website").map(
			(flow) => flow.title,
		);
		for (const title of titles) expect(text).toContain(`## ${title}`);
		expect(text).not.toContain("## Update my website");
	});

	it("lists only what the connection can't do in the limits guide", async () => {
		const read = async (surface: SurfaceName) => {
			const client = await connect({ surface });
			const { contents } = await client.readResource({
				uri: "whop://guides/connector-limits",
			});
			return contents[0] && "text" in contents[0] ? contents[0].text : "";
		};
		const muse = await read("muse");
		expect(muse).toContain("Payouts and withdrawals");
		expect(muse).toContain("website");
		expect(muse).not.toContain("Refund");
		const full = await read("full");
		expect(full).not.toContain("Payouts and withdrawals");
		expect(full).toContain("Uploading a file");
	});

	it("rejects an unknown resource, and a guide the connection can't use", async () => {
		const client = await connect();
		await expect(
			client.readResource({ uri: "whop://guides/payouts" }),
		).rejects.toThrow(/Unknown resource/);
		await expect(
			client.readResource({ uri: "whop://guides/website" }),
		).rejects.toThrow(/Unknown resource/);
	});

	it("passes the option through the HTTP adapter", async () => {
		const handler = createStreamableHttpHandler({
			registry,
			surface: "muse",
			toolListing: "compact",
			promptsAndResources: true,
			authenticator: {
				async authenticate() {
					return {
						principal: userPrincipal,
						credentialAdapter: staticCredential(),
					};
				},
			},
		});
		const response = await handler(
			new Request("https://mcp.whop.test/muse/mcp", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Accept: "application/json, text/event-stream",
				},
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					method: "prompts/list",
					params: {},
				}),
			}),
		);
		const body = (await response.json()) as {
			result?: { prompts: { name: string }[] };
		};
		expect(body.result?.prompts.map((prompt) => prompt.name)).toContain(
			"answer_support_chats",
		);
	});
});
