import type { SurfaceName, ToolListing } from "@whop/mcp-server";
import { createStreamableHttpHandler } from "@whop/mcp-server/streamable-http";
import { registry } from "./registry.ts";
import {
	attributionHeaders,
	CHATGPT_PROFILE,
	MUSE_PROFILE,
	readPluginSource,
	credentialAdapterFromProps,
	EXPIRY_SLACK_MS,
	parseGrantProps,
	principalFromProps,
	StructuredLogAuditSink,
	unauthorized,
	wrongRoute,
} from "./grant.ts";
import type { Env } from "./types.ts";
import { ApiFeedbackSink } from "./feedback.ts";

/**
 * The authenticated MCP handler for one route. workers-oauth-provider has
 * already validated the MCP access token and decrypted the grant props by the
 * time this runs; the props carry the server-side Whop credential, which is
 * never exposed to the client or the model.
 *
 * `surface` is fixed per route, so what a connection can reach depends only
 * on the URL it was configured with — never on a header the client sends.
 */
// The ChatGPT route keeps every tool listed: OpenAI's plugin guidelines bar
// generic search and call tools for actions not listed on their own.
function listingFor(surface: SurfaceName): ToolListing {
	return surface === "chatgpt" ? "full" : "compact";
}

// A token with no audience passes the provider's route check, so this is what
// keeps full-scope grants off the routes with a narrowed grant.
function requiredProfile(surface: SurfaceName): string | undefined {
	if (surface === "muse") return MUSE_PROFILE;
	if (surface === "chatgpt") return CHATGPT_PROFILE;
	return undefined;
}

export function createMcpApiHandler(surface: SurfaceName = "full") {
	return {
		async fetch(
			request: Request,
			env: Env,
			ctx: ExecutionContext,
		): Promise<Response> {
			const profile = requiredProfile(surface);
			// A client that signs in again follows this header to the resource it
			// requests. The root document would get it a full-scope grant, which
			// these routes reject.
			const metadataPath =
				profile === undefined ? "" : new URL(request.url).pathname;
			const props = parseGrantProps(ctx.props);
			if (!props) {
				return unauthorized(
					env,
					"Grant is missing its Whop credential.",
					metadataPath,
				);
			}
			if (profile !== undefined && props.profile !== profile) {
				return wrongRoute(env, new URL(request.url).pathname);
			}
			const muse = surface === "muse";
			// The MCP access token TTL matches Whop's, so an expired Whop token
			// means this MCP token is at end of life too: 401 here drives the
			// client through /token refresh, where the Whop token is rotated.
			if (props.whopExpiresAt <= Date.now() + EXPIRY_SLACK_MS) {
				return unauthorized(
					env,
					"The connection's credential expired. Refresh the access token.",
					metadataPath,
				);
			}

			const handler = createStreamableHttpHandler({
				registry,
				auditSink: new StructuredLogAuditSink(),
				feedbackSink: muse
					? undefined
					: new ApiFeedbackSink(env.MCP_WHOP_API_ORIGIN, props.whopAccessToken),
				docs: true,
				baseUrl: `${env.MCP_WHOP_API_ORIGIN}/api/v1`,
				requireHttps: env.MCP_BASE_URL.startsWith("https://"),
				chatGptCompat: !muse,
				surface,
				toolListing: listingFor(surface),
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
