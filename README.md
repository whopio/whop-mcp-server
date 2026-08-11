# Whop MCP Server

<img src="assets/logo.png" alt="Whop" width="96" />

The official public source for Whop's hosted Model Context Protocol (MCP)
server. This implementation powers the remote endpoint at
[`https://mcp.whop.com/mcp`](https://mcp.whop.com/mcp) and the Whop plugin for
Cursor.

The hosted implementation uses browser-based OAuth so a
Whop API key never needs to be copied into an MCP client configuration.

> This repository is separate from the local,
> API-key-based [`@whop/mcp`](https://www.npmjs.com/package/@whop/mcp)
> package. Existing users of that package are unaffected by the hosted server.

## Connect from Cursor

When the Whop listing is live, install it from the Cursor Marketplace. For
development or pre-publication testing, add the following to your Cursor MCP
configuration:

```json
{
  "mcpServers": {
    "whop": {
      "type": "http",
      "url": "https://mcp.whop.com/mcp"
    }
  }
}
```

Do not add an API key, bearer token, or custom authorization header. On first
use, the MCP client discovers the server's OAuth metadata and opens Whop in the
browser for sign-in and authorization. Credentials are kept server-side rather
than placed in the client configuration or exposed to the model.

## Access and safety

### Full-admin scope

The hosted endpoint currently requests the MCP `admin` scope. That is the full
administrative permission profile for the reviewed Whop MCP surface, not a
read-only or per-tool grant. It can act on resources your Whop user is allowed
to access across every business the user manages; grants are not bound to one
business. Only connect MCP clients you trust, inspect requested actions, and
disconnect access when it is no longer needed.

### Prepare and confirm

Consequential operations, including financial, credential, and destructive
actions, use a two-step safeguard:

1. The first call prepares the operation and returns a preview plus an
   `mcp_confirmation_token`. It does not execute the operation.
2. After the user reviews and approves the preview, the client calls the same
   tool with the same arguments, the confirmation token, and a stable
   `idempotency_key` to execute it.

Clients should never confirm consequential actions without user approval. They
must reuse the same idempotency key when retrying. If an outcome is reported as
unknown, verify the result before attempting another execution. These
safeguards reduce accidental or duplicate actions; they do not reduce the
privileges of the OAuth grant. Prepare-and-confirm is not a security boundary
against a compromised MCP bearer token or Worker: either can act within the
grant's full privileges.

## Repository layout

| Path | Purpose |
| --- | --- |
| `packages/server` | OpenAPI-derived operation registry, policy enforcement, MCP runtime, and transport adapters |
| `apps/worker` | Hosted OAuth and Streamable HTTP endpoint deployed at `mcp.whop.com` |
| `.cursor-plugin/plugin.json` | Cursor Marketplace plugin manifest |
| `mcp.json` | Public remote MCP configuration consumed by Cursor |

## Development

Prerequisites:

- Node.js 22 or newer
- pnpm 10 or newer (the repository pins pnpm 10.23.0)

Install dependencies and run the complete local verification suite:

```bash
corepack enable
pnpm install
pnpm check
```

The root commands run across both workspaces:

```bash
pnpm build        # generate and build the server package
pnpm check-types  # build, then type-check both workspaces
pnpm lint
pnpm test
pnpm format
```

To start the hosted adapter locally after installing dependencies:

```bash
pnpm build
pnpm --filter @whop/mcp-worker dev
```

Local development secrets belong in `apps/worker/.dev.vars`, which is ignored
by Git. Never commit API keys, OAuth client secrets, access tokens, or populated
environment files.

The public Worker configuration is intentionally limited to local development.
Whop's production routes, Cloudflare account and namespace identifiers,
deployment credentials, and infrastructure automation are operated separately
and are not stored here. The OAuth client ID remains public because OAuth
authorization requests expose it by design.

## Contributing

1. Fork the repository and create a focused branch.
2. Make the change, including tests and safety metadata where relevant.
3. Run `pnpm check` from the repository root.
4. Open a pull request describing the behavior and its security implications.

Use GitHub Issues for reproducible bugs and feature requests. Use the
repository's Security tab for vulnerability reports so sensitive details are
not posted publicly.

## Terms, privacy, and license

Use of the hosted service is subject to Whop's
[Terms of Service](https://whop.com/tos/) and
[Privacy Policy](https://whop.com/privacy).

The source code in this repository is licensed under the
[Apache License 2.0](LICENSE).
