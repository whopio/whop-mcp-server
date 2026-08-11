import { EXPIRY_SLACK_MS, parseGrantProps, unauthorized } from "./grant.ts";
import type { Env } from "./types.ts";

/**
 * The authenticated legacy-SSE handler, covering GET /sse (open a stream)
 * and POST /sse/message?sessionId=… (speak on it). New clients negotiate
 * Streamable HTTP at /mcp. The provider has already validated the MCP access
 * token and decrypted the grant props by the time this runs.
 */
export function createSseApiHandler() {
	return {
		async fetch(
			request: Request,
			env: Env,
			ctx: ExecutionContext,
		): Promise<Response> {
			const props = parseGrantProps(ctx.props);
			if (!props) {
				return unauthorized(env, "Grant is missing its Whop credential.");
			}
			if (props.whopExpiresAt <= Date.now() + EXPIRY_SLACK_MS) {
				return unauthorized(
					env,
					"The connection's credential expired. Refresh the access token.",
				);
			}

			const url = new URL(request.url);

			if (url.pathname === "/sse" && request.method === "GET") {
				const sessionId = crypto.randomUUID();
				const stub = env.SSE_SESSIONS.get(
					env.SSE_SESSIONS.idFromName(sessionId),
				);
				return stub.fetch("https://sse-session/open", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						props,
						endpointUrl: `${env.MCP_BASE_URL}/sse/message?sessionId=${sessionId}`,
					}),
				});
			}

			if (url.pathname === "/sse/message" && request.method === "POST") {
				const sessionId = url.searchParams.get("sessionId");
				if (!sessionId) {
					return Response.json(
						{ error: "missing_session_id" },
						{ status: 400 },
					);
				}
				const stub = env.SSE_SESSIONS.get(
					env.SSE_SESSIONS.idFromName(sessionId),
				);
				return stub.fetch("https://sse-session/message", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"x-session-owner": props.userId,
						// The stream outlives the Whop token behind it; hand the DO
						// the caller's current one so a refreshed connection doesn't
						// keep calling upstream with the token from /open.
						"x-session-token": props.whopAccessToken,
					},
					body: request.body,
				});
			}

			return new Response("Not found", { status: 404 });
		},
	};
}
