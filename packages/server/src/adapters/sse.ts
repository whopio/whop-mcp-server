import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
	JSONRPCMessageSchema,
	type JSONRPCMessage,
} from "@modelcontextprotocol/sdk/types.js";
import {
	createWhopMcpServer,
	type CreateWhopMcpServerOptions,
} from "../runtime/server.ts";
import { WhopMcpError } from "../runtime/errors.ts";

const encoder = new TextEncoder();

export interface SseSessionOptions extends CreateWhopMcpServerOptions {
	/**
	 * The URI clients POST their JSON-RPC messages to, announced as the
	 * transport's first event. Absolute (same-origin) or path-relative.
	 */
	endpointUrl: string;
	/** Keep-alive comment interval; 0 disables (tests). */
	keepAliveMs?: number;
}

/**
 * The legacy HTTP+SSE transport (protocol 2024-11-05), which is still the
 * dominant transport in production: the client holds one long-lived SSE
 * stream (GET /sse) and POSTs messages to the announced endpoint; every
 * server message flows back over the stream. One instance is one session,
 * hosted inside a Durable Object so the stream and its MCP server survive
 * across the message POSTs.
 */
export class SseSession {
	readonly #writer: WritableStreamDefaultWriter<Uint8Array>;
	readonly #readable: ReadableStream<Uint8Array>;
	readonly #transport: Transport;
	readonly #keepAlive: ReturnType<typeof setInterval> | undefined;
	readonly #ready: Promise<void>;
	#closed = false;

	constructor(options: SseSessionOptions) {
		const { endpointUrl, keepAliveMs = 25_000, ...serverOptions } = options;
		const stream = new TransformStream<Uint8Array, Uint8Array>();
		this.#writer = stream.writable.getWriter();
		this.#readable = stream.readable;

		const write = async (chunk: string): Promise<void> => {
			if (this.#closed) return;
			try {
				await this.#writer.write(encoder.encode(chunk));
			} catch {
				// The client went away; tear the session down so the server and
				// keep-alive timer don't outlive the stream.
				await this.close();
			}
		};

		this.#transport = {
			start: async () => {
				await write(`event: endpoint\ndata: ${endpointUrl}\n\n`);
			},
			send: async (message) => {
				await write(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
			},
			close: async () => {
				await this.close();
			},
		};

		const { server } = createWhopMcpServer(serverOptions);
		this.#ready = server.connect(this.#transport);

		this.#keepAlive =
			keepAliveMs > 0
				? setInterval(() => {
						void write(": keepalive\n\n");
					}, keepAliveMs)
				: undefined;
	}

	get closed(): boolean {
		return this.#closed;
	}

	/** The SSE stream response for the originating GET. */
	response(): Response {
		return new Response(this.#readable, {
			headers: {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache, no-transform",
				Connection: "keep-alive",
			},
		});
	}

	/** Feed one client-POSTed JSON-RPC message into the session. */
	async handleMessage(raw: unknown): Promise<void> {
		if (this.#closed) {
			throw new WhopMcpError("internal_error", "This session is closed.");
		}
		await this.#ready;
		const parsed = JSONRPCMessageSchema.safeParse(raw);
		if (!parsed.success) {
			throw new WhopMcpError(
				"invalid_input",
				"Body is not a valid JSON-RPC message.",
			);
		}
		this.#transport.onmessage?.(parsed.data as JSONRPCMessage);
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		if (this.#keepAlive !== undefined) clearInterval(this.#keepAlive);
		this.#transport.onclose?.();
		try {
			await this.#writer.close();
		} catch {
			// Stream already errored/closed with the client.
		}
	}
}
