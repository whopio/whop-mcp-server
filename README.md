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

### Approval and retries

Every tool call executes when it is made. Approval belongs to the MCP host:
financial, credential, and destructive tools carry `destructiveHint`, which
hosts use to ask the user before running them.

Write tools accept an `idempotency_key`, which the server sends to the Whop
API as the `Idempotency-Key` header. Reuse the same key when retrying a call
whose outcome is unclear; the API replays the completed response instead of
executing twice.

### Intent attribution

Every API-backed operation tool requires two attribution fields:

- `intent` is the original user request that led to the tool call. Clients
  should copy it verbatim when available.
- `intent_id` is a UUID generated once per user message and reused for every
  operation tool call made to fulfill that message. It distinguishes separate
  turns that happen to contain the same request text.

These fields are removed before operation validation and are never sent as
Whop API arguments. A bounded copy is attached to the downstream request so
Whop can analyze API request intent. The MCP protocol does not expose the host
conversation, so both values are client-supplied attribution rather than
server-verified chat history. ChatGPT's fixed-schema `search` and `fetch`
compatibility tools and the local `connection_status` diagnostic do not use
these fields.

### Feedback and unanswered questions

The hosted server exposes two tools for sending observations to Whop for
internal review:

- `report_feedback` records a concrete problem, documentation gap, or confusing
  behavior. Optional fields capture task impact (`blocked`, `degraded`, or
  `cosmetic`) and a workaround.
- `ask_question` records a question the available tools and documentation could
  not answer. It returns a receipt, not an answer; no response will arrive later
  in the session.

Both require `content` and optionally accept `intention`, `tool`, and
`modelType`. They do not require `intent` or `intent_id`. Submissions include
the authenticated identity and available client attribution and are written to
Whop's ClickHouse analytics events for internal review. Ingestion is asynchronous.
They are not support tickets or a private
journal. Remove credentials, personal data, and payment details before sending.
These tools are available only when the host configures a feedback sink.

### Documentation search

Two read-only tools let an agent search and read the Whop documentation over
the same connection:

- `docs_search` takes a plain-language `query`, and optionally a docs
  `version`, and returns matching excerpts with page paths and links. Each
  excerpt is capped at 2,000 characters and names the `docs_query` command
  that reads its full page.
- `docs_query` runs a read-only, shell-style `command` such as `tree`, `rg`, or
  `head` against a virtual filesystem holding only the documentation pages. Use
  it to read a page that `docs_search` returned.

Both read the public documentation and send no Whop credentials. They are available on every surface and permission
profile. The stdio adapter enables them by default; the hosted adapter enables
them with `docs: true`. A rate-limited docs lookup is returned as
`upstream_error` with status 429 and its `Retry-After` hint.

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

This repository is an automatically generated mirror of the source deployed by
Whop. Direct source changes here will be overwritten by the next production
sync. Use GitHub Issues for reproducible bugs and feature requests; the Whop
team will land changes in the canonical source before publishing them here.

Use the repository's Security tab for vulnerability reports so sensitive
details are not posted publicly.

## Terms, privacy, and license

Use of the hosted service is subject to Whop's
[Terms of Service](https://whop.com/tos/) and
[Privacy Policy](https://whop.com/privacy).

The source code in this repository is licensed under the
[Apache License 2.0](LICENSE).
