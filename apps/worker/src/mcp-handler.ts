import { createStreamableHttpHandler } from "@whop/mcp-server/streamable-http";
import { durableIdempotencyStore } from "./idempotency-do.ts";
import { registry } from "./registry.ts";
import {
	attributionHeaders,
	readPluginSource,
	credentialAdapterFromProps,
	EXPIRY_SLACK_MS,
	parseGrantProps,
	principalFromProps,
	StructuredLogAuditSink,
	unauthorized,
} from "./grant.ts";
import type { Env } from "./types.ts";
import { ApiFeedbackSink } from "./feedback.ts";

/**
 * The authenticated /mcp handler. workers-oauth-provider has already
 * validated the MCP access token and decrypted the grant props by the time
 * this runs; the props carry the server-side Whop credential, which is never
 * exposed to the client or the model.
 */
export function createMcpApiHandler() {
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
			// The MCP access token TTL matches Whop's, so an expired Whop token
			// means this MCP token is at end of life too: 401 here drives the
			// client through /token refresh, where the Whop token is rotated.
			if (props.whopExpiresAt <= Date.now() + EXPIRY_SLACK_MS) {
				return unauthorized(
					env,
					"The connection's credential expired. Refresh the access token.",
				);
			}

			const handler = createStreamableHttpHandler({
				registry,
				confirmationSecret: env.MCP_CONFIRMATION_SECRET,
				idempotencyStore: durableIdempotencyStore(env.IDEMPOTENCY),
				auditSink: new StructuredLogAuditSink(),
				feedbackSink: new ApiFeedbackSink(
					env.MCP_WHOP_API_ORIGIN,
					props.whopAccessToken,
				),
				baseUrl: `${env.MCP_WHOP_API_ORIGIN}/api/v1`,
				requireHttps: env.MCP_BASE_URL.startsWith("https://"),
				chatGptCompat: true,
				authenticator: {
					async authenticate() {
						const pluginSource = readPluginSource(request);
						return {
							principal: principalFromProps(props),
							clientName: props.mcpClientName,
							credentialAdapter: credentialAdapterFromProps(props),
							pluginSource,
							extraHeaders: attributionHeaders(env, props, pluginSource),
						};
					},
				},
			});
			return handler(request);
		},
	};
}
