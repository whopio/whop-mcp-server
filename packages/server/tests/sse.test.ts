import { describe, expect, it } from "vitest";
import { SseSession } from "../src/adapters/sse.ts";
import {
	buildRealRegistry,
	fakeFetch,
	principalFixture,
	staticCredential,
} from "./helpers.ts";

const registry = buildRealRegistry();
const SECRET = "test-secret-key-that-is-long-enough";

function makeSession(fetchImpl?: typeof fetch) {
	return new SseSession({
		registry,
		credentialAdapter: staticCredential(),
		principal: principalFixture(),
		confirmationSecret: SECRET,
		fetch: fetchImpl ?? fakeFetch().fetch,
		baseUrl: "https://api.whop.test/api/v1",
		endpointUrl: "/sse/message?sessionId=test-session",
		keepAliveMs: 0,
	});
}

/** Reads decoded stream text until `count` complete SSE events have arrived. */
async function readEvents(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	count: number,
): Promise<{ event: string; data: string }[]> {
	const decoder = new TextDecoder();
	let buffer = "";
	while (buffer.split("\n\n").filter(Boolean).length < count) {
		const { value, done } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
	}
	return buffer
		.split("\n\n")
		.filter((block) => block.includes("event:"))
		.map((block) => {
			const event = /event: (.*)/.exec(block)?.[1] ?? "";
			const data = /data: (.*)/.exec(block)?.[1] ?? "";
			return { event, data };
		});
}

describe("SSE transport session", () => {
	it("announces the message endpoint as the first event", async () => {
		const session = makeSession();
		const reader = session.response().body!.getReader();
		const [first] = await readEvents(reader, 1);
		expect(first.event).toBe("endpoint");
		expect(first.data).toBe("/sse/message?sessionId=test-session");
		await session.close();
	});

	it("serves initialize and tool calls over the stream", async () => {
		const { fetch, requests } = fakeFetch(() => ({
			body: { data: [{ id: "prod_1" }] },
		}));
		const session = makeSession(fetch);
		const reader = session.response().body!.getReader();
		await readEvents(reader, 1);

		await session.handleMessage({
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: {
				protocolVersion: "2024-11-05",
				capabilities: {},
				clientInfo: { name: "legacy-sse-client", version: "1.0" },
			},
		});
		const [initEvent] = await readEvents(reader, 1);
		expect(initEvent.event).toBe("message");
		const init = JSON.parse(initEvent.data);
		expect(init.result.serverInfo.name).toBe("whop");

		await session.handleMessage({
			jsonrpc: "2.0",
			method: "notifications/initialized",
		});
		await session.handleMessage({
			jsonrpc: "2.0",
			id: 2,
			method: "tools/call",
			params: { name: "products_list", arguments: {} },
		});
		const [callEvent] = await readEvents(reader, 1);
		const call = JSON.parse(callEvent.data);
		expect(call.id).toBe(2);
		expect(JSON.parse(call.result.content[0].text)).toEqual({
			data: [{ id: "prod_1" }],
		});
		expect(requests.length).toBe(1);
		await session.close();
	});

	it("rejects malformed messages without killing the session", async () => {
		const session = makeSession();
		const reader = session.response().body!.getReader();
		await readEvents(reader, 1);
		await expect(session.handleMessage({ nonsense: true })).rejects.toThrow(
			/JSON-RPC/,
		);
		expect(session.closed).toBe(false);
		await session.close();
	});

	it("closing ends the stream", async () => {
		const session = makeSession();
		const reader = session.response().body!.getReader();
		await readEvents(reader, 1);
		await session.close();
		const { done } = await reader.read();
		expect(done).toBe(true);
		await expect(session.handleMessage({})).rejects.toThrow(/closed/);
	});
});
