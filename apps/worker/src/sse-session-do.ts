import { DurableObject } from "cloudflare:workers";
import { SseSession } from "@whop/mcp-server/sse";
import { registry } from "./registry.ts";
import { durableIdempotencyStore } from "./idempotency-do.ts";
import {
	attributionHeaders,
	principalFromProps,
	StructuredLogAuditSink,
} from "./grant.ts";
import type { Env, WhopGrantProps } from "./types.ts";

interface OpenPayload {
	props: WhopGrantProps;
	endpointUrl: string;
}

/**
 * One Durable Object per SSE session: holds the long-lived stream and its
 * MCP server so the message POSTs (which land as separate Worker requests)
 * reach the same live session. Evicted state simply means the stream is
 * gone, so the client reconnects with a fresh GET /sse.
 */
export class SseSessionDO extends DurableObject<Env> {
	#session: SseSession | undefined;
	#ownerUserId: string | undefined;
	#accessToken: string | undefined;

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === "/open" && request.method === "POST") {
			const { props, endpointUrl } = (await request.json()) as OpenPayload;
			if (this.#session && !this.#session.closed) {
				await this.#session.close();
			}
			this.#ownerUserId = props.userId;
			this.#accessToken = props.whopAccessToken;
			this.#session = new SseSession({
				registry,
				endpointUrl,
				principal: principalFromProps(props),
				// Reads the token live rather than closing over the one captured
				// at /open: an SSE stream outlives the hourly Whop token, and
				// every /message POST carries the caller's current one.
				credentialAdapter: {
					getCredential: async () => {
						if (!this.#accessToken) {
							throw new Error("This SSE session has no credential.");
						}
						return { token: this.#accessToken };
					},
				},
				confirmationMode: "enforce",
				confirmationSecret: this.env.MCP_CONFIRMATION_SECRET,
				idempotencyStore: durableIdempotencyStore(this.env.IDEMPOTENCY),
				auditSink: new StructuredLogAuditSink(),
				baseUrl: `${this.env.MCP_WHOP_API_ORIGIN}/api/v1`,
				chatGptCompat: true,
				extraHeaders: attributionHeaders(this.env, props, "sse"),
			});
			return this.#session.response();
		}

		if (url.pathname === "/message" && request.method === "POST") {
			if (!this.#session || this.#session.closed) {
				// Gone (evicted or closed): a 404 tells the client to reconnect.
				return Response.json({ error: "session_not_found" }, { status: 404 });
			}
			// The session is bound to the user whose token opened the stream —
			// a different (even valid) token must not be able to speak on it.
			if (request.headers.get("x-session-owner") !== this.#ownerUserId) {
				return Response.json({ error: "forbidden" }, { status: 403 });
			}
			const refreshedToken = request.headers.get("x-session-token");
			if (refreshedToken) this.#accessToken = refreshedToken;
			let body: unknown;
			try {
				body = await request.json();
			} catch {
				return Response.json({ error: "invalid_json" }, { status: 400 });
			}
			try {
				await this.#session.handleMessage(body);
			} catch (error) {
				return Response.json(
					{
						error: "invalid_message",
						message: error instanceof Error ? error.message : "invalid",
					},
					{ status: 400 },
				);
			}
			return new Response(null, { status: 202 });
		}

		return new Response("Not found", { status: 404 });
	}
}
