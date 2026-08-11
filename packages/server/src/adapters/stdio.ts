import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { RegistryManifest } from "../registry/types.ts";
import type { CredentialAdapter, PrincipalContext } from "../policy/types.ts";
import { DEFAULT_PROFILE } from "../policy/profiles.ts";
import {
	createWhopMcpServer,
	type CreateWhopMcpServerOptions,
} from "../runtime/server.ts";
import { ConsoleErrorAuditSink } from "./stdio-audit.ts";

export interface ServeStdioOptions extends Omit<
	CreateWhopMcpServerOptions,
	"credentialAdapter" | "principal"
> {
	registry: RegistryManifest;
	credentialAdapter?: CredentialAdapter;
	principal?: PrincipalContext;
}

/**
 * Runs the shared runtime over stdio. Protocol traffic is the only thing that
 * touches stdout; logs and audit events go to stderr. Credentials come from an
 * injected adapter (the public CLI passes its keychain/profile resolution) or
 * the WHOP_API_KEY environment fallback — never from MCP client config values.
 *
 * Confirmation defaults to "host-approval": local hosts already interpose
 * per-call human approval, and destructiveHint disables auto-approve, so the
 * token round-trip would be a second "are you sure?".
 */
export async function serveStdio(options: ServeStdioOptions): Promise<void> {
	const credentialAdapter = options.credentialAdapter ?? envCredentialAdapter();

	const principal: PrincipalContext = options.principal ?? {
		principalType: "business",
		accountId: null,
		scopes: ["*"],
		permissionProfile: DEFAULT_PROFILE,
	};

	const { server } = createWhopMcpServer({
		...options,
		credentialAdapter,
		principal,
		confirmationMode: options.confirmationMode ?? "host-approval",
		auditSink: options.auditSink ?? new ConsoleErrorAuditSink(),
	});

	const transport = new StdioServerTransport();
	await server.connect(transport);
}

function envCredentialAdapter(): CredentialAdapter {
	return {
		async getCredential() {
			const token = process.env.WHOP_API_KEY;
			if (!token) {
				throw new Error(
					"No credential available: set WHOP_API_KEY or sign in with `whop login`.",
				);
			}
			return { token: token.replace(/^Bearer\s+/i, "") };
		},
	};
}
