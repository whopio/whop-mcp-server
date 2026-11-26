import {
	createMcpHandler,
	isLegacyRequest,
	WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";
import type { RegistryManifest } from "../registry/types.ts";
import type { SurfaceName } from "../policy/surfaces.ts";
import type { ToolListing } from "../runtime/server.ts";
import type { CredentialAdapter, PrincipalContext } from "../policy/types.ts";
import type { AuditSink } from "../safety/audit.ts";
import { createWhopMcpServer } from "../runtime/server.ts";

/**
 * The hosted adapter's authentication seam. Implementations validate the
 * inbound MCP access token (audience-bound to the canonical MCP resource),
 * and return the trusted connection context plus a server-side downstream
 * credential. The inbound token itself is never forwarded to the Whop API.
 */
export interface HttpAuthenticator {
	authenticate(request: Request): Promise<{
		principal: PrincipalContext;
		credentialAdapter: CredentialAdapter;
		clientName?: string;
		pluginSource?: string;
		/** Extra attribution headers stamped on this connection's upstream calls. */
		extraHeaders?: Record<string, string>;
	}>;
}

export class HttpAuthError extends Error {
	readonly status: number;
	readonly headers: Record<string, string>;

	constructor(
		status: number,
		message: string,
		headers: Record<string, string> = {},
	) {
		super(message);
		this.status = status;
		this.headers = headers;
	}
}

export interface StreamableHttpAdapterOptions {
	registry: RegistryManifest;
	authenticator: HttpAuthenticator;
	auditSink?: AuditSink;
	feedback?: boolean;
	docs?: boolean;
	fetch?: typeof fetch;
	baseUrl?: string;
	/**
	 * Restrict browser callers to these origins. When omitted, requests with
	 * an Origin header are NOT filtered: this is a stateless bearer-token API
	 * with no cookies, so cross-origin requests carry no ambient authority,
	 * and browser-based MCP clients (claude.ai, ChatGPT web) send Origin
	 * values that cannot be enumerated in advance.
	 */
	allowedOrigins?: string[];
	/** Require HTTPS request URLs (enable in deployed environments). */
	requireHttps?: boolean;
	/** Expose the ChatGPT-required search/fetch meta-tools. */
	chatGptCompat?: boolean;
	/** The fixed tool subset this endpoint serves (full by default). */
	surface?: SurfaceName;
	/** Which operations tools/list shows (see CreateWhopMcpServerOptions). */
	toolListing?: ToolListing;
	/** Serve the guide prompts and resources (see CreateWhopMcpServerOptions). */
	promptsAndResources?: boolean;
}

function jsonRpcError(status: number, code: number, message: string): Response {
	return new Response(
		JSON.stringify({
			jsonrpc: "2.0",
			error: { code, message },
			id: null,
		}),
		{ status, headers: { "Content-Type": "application/json" } },
	);
}

/**
 * Stateless Streamable HTTP endpoint: every POST is authenticated, builds a
 * per-request server over the shared runtime, and streams the response (JSON
 * or SSE, negotiated by the transport). Requests carrying the 2026-07-28
 * per-request envelope go to the SDK's modern handler; everything else takes
 * the 2025-era stateless transport. GET/DELETE return 405 — there are no
 * stateful sessions to resume in this adapter.
 */
export function createStreamableHttpHandler(
	options: StreamableHttpAdapterOptions,
): (request: Request) => Promise<Response> {
	return async (request: Request): Promise<Response> => {
		const url = new URL(request.url);

		if (options.requireHttps && url.protocol !== "https:") {
			return jsonRpcError(400, -32000, "HTTPS is required.");
		}

		const origin = request.headers.get("Origin");
		if (
			origin &&
			options.allowedOrigins &&
			!isAllowedOrigin(origin, options.allowedOrigins)
		) {
			return jsonRpcError(403, -32000, "Origin not allowed.");
		}

		if (request.method !== "POST") {
			return jsonRpcError(405, -32000, "Method not allowed.");
		}

		if (url.searchParams.size > 0) {
			for (const key of url.searchParams.keys()) {
				if (/token|key|secret|authorization/i.test(key)) {
					return jsonRpcError(
						400,
						-32000,
						"Credentials must be sent in the Authorization header, not query parameters.",
					);
				}
			}
		}

		let auth: Awaited<ReturnType<HttpAuthenticator["authenticate"]>>;
		try {
			auth = await options.authenticator.authenticate(request);
		} catch (error) {
			if (error instanceof HttpAuthError) {
				return new Response(
					JSON.stringify({
						jsonrpc: "2.0",
						error: { code: -32001, message: error.message },
						id: null,
					}),
					{
						status: error.status,
						headers: {
							"Content-Type": "application/json",
							...error.headers,
						},
					},
				);
			}
			return jsonRpcError(401, -32001, "Authentication failed.");
		}

		const { server } = createWhopMcpServer({
			registry: options.registry,
			credentialAdapter: auth.credentialAdapter,
			principal: auth.principal,
			auditSink: options.auditSink,
			feedback: options.feedback,
			docs: options.docs,
			fetch: options.fetch,
			baseUrl: options.baseUrl,
			clientName: auth.clientName,
			pluginSource: auth.pluginSource,
			chatGptCompat: options.chatGptCompat,
			surface: options.surface,
			toolListing: options.toolListing,
			promptsAndResources: options.promptsAndResources,
			extraHeaders: auth.extraHeaders,
		});

		if (!(await isLegacyRequest(request))) {
			const rejected = await rejectSubscriptionStream(request);
			if (rejected) return rejected;
			return createMcpHandler(() => server, { legacy: "reject" }).fetch(
				request,
			);
		}

		const transport = new WebStandardStreamableHTTPServerTransport({
			sessionIdGenerator: undefined,
			enableJsonResponse: true,
		});
		await server.connect(transport);
		return transport.handleRequest(request);
	};
}

// The server publishes no change notifications, so a subscription stream
// would stay open with nothing on it, holding a per-request server and
// outliving the access token that opened it.
async function rejectSubscriptionStream(
	request: Request,
): Promise<Response | undefined> {
	const body = (await request
		.clone()
		.json()
		.catch(() => undefined)) as { id?: unknown; method?: unknown } | undefined;
	if (body?.method !== "subscriptions/listen") return undefined;
	return new Response(
		JSON.stringify({
			jsonrpc: "2.0",
			id: body.id ?? null,
			error: { code: -32601, message: "Method not found" },
		}),
		{ status: 404, headers: { "Content-Type": "application/json" } },
	);
}

function isAllowedOrigin(origin: string, allowed: string[]): boolean {
	if (allowed.includes(origin)) return true;
	try {
		const { hostname } = new URL(origin);
		return allowed.some(
			(entry) => entry.startsWith("*.") && hostname.endsWith(entry.slice(1)),
		);
	} catch {
		return false;
	}
}
