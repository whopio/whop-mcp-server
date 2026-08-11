# Whop MCP Cloudflare Worker

This app is the Cloudflare Worker entry point for Whop's hosted MCP server. It
adds browser-based OAuth to the operation registry provided by
`@whop/mcp-server` and serves it over Streamable HTTP.

Users sign in to Whop in their browser. The Worker stores the resulting Whop
credentials in encrypted OAuth grant properties; MCP clients and models never
receive those credentials.

## Connect to the hosted server

Use the public Streamable HTTP endpoint in any MCP client that supports remote
servers:

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

The server grants the connected client the full reviewed MCP surface available
to the signed-in user. Consequential operations use a prepare-and-confirm flow,
but you should still connect only MCP clients you trust.

Legacy clients can use `https://mcp.whop.com/sse`. New integrations should use
the `/mcp` endpoint.

## Runtime architecture

```text
MCP client ── OAuth 2.1 + PKCE ──> Cloudflare Worker ── Whop OIDC ──> Whop API
                                  │
                                  ├─ /mcp  Streamable HTTP
                                  └─ /sse  legacy HTTP + SSE
```

The Worker provides:

- OAuth 2.1 authorization, dynamic client registration, protected-resource
  metadata, and client-ID metadata document support through
  `@cloudflare/workers-oauth-provider`.
- PKCE for both the MCP client flow and the upstream Whop authorization flow.
- Encrypted, short-lived pending authorization state in Workers KV.
- Durable Object-backed idempotency for consequential API operations.
- Durable Object-backed sessions for the legacy SSE transport.
- Structured audit events written to the Worker log stream.

## Local development

Prerequisites:

- Node.js 22 or newer
- pnpm
- A Whop OAuth client secret matching the public client ID in
  `src/whop-oidc.ts` for end-to-end sign-in testing

From the repository root:

```bash
pnpm install
pnpm --filter @whop/mcp-server build
cp apps/worker/.dev.vars.example apps/worker/.dev.vars
pnpm --filter @whop/mcp-worker dev
```

The Worker starts at `http://localhost:8788`. The registered Whop OAuth app
must allow `http://localhost:8788/callback` as a redirect URI, and its client
secret must be permitted to exchange OAuth tokens.

Replace every placeholder in `.dev.vars`. Use separate random values for the
confirmation and state-encryption secrets; for example:

```bash
openssl rand -hex 32
```

`.dev.vars` is ignored by Git. Never commit OAuth client secrets or generated
secret values.

Unit tests do not call Whop or require live credentials:

```bash
pnpm --filter @whop/mcp-worker check-types
pnpm --filter @whop/mcp-worker lint
pnpm --filter @whop/mcp-worker test
```

## Configuration

The checked-in `wrangler.jsonc` is intentionally limited to local development
and contains no Whop or Cloudflare account-specific deployment data.

### Variables

| Name | Purpose | Local value |
| --- | --- | --- |
| `MCP_BASE_URL` | Public origin used for OAuth callbacks and metadata | `http://localhost:8788` |
| `MCP_WHOP_API_ORIGIN` | Whop API and OIDC origin | `https://api.whop.com` |

### Secrets

| Name | Purpose |
| --- | --- |
| `MCP_WHOP_OAUTH_CLIENT_SECRET` | Confidential Whop OAuth client credential |
| `MCP_CONFIRMATION_SECRET` | Signs prepare-and-confirm state for consequential operations |
| `MCP_STATE_ENCRYPTION_KEY` | Encrypts pending OAuth state stored in KV |

### Cloudflare bindings

| Binding | Type | Purpose |
| --- | --- | --- |
| `OAUTH_KV` | Workers KV | Pending OAuth authorization state |
| `IDEMPOTENCY` | Durable Object | Serialized idempotency records |
| `SSE_SESSIONS` | Durable Object | Legacy SSE sessions |
| `CF_VERSION_METADATA` | Version metadata | Runtime version attribution |

## Deploying a separate instance

The official Whop deployment configuration, infrastructure IDs, routes, and
credentials are intentionally not part of this public repository. To deploy a
separate instance, provide your own:

1. Cloudflare account and Workers deployment configuration.
2. Workers KV namespace bound as `OAUTH_KV`.
3. Confidential Whop OAuth app with `<MCP_BASE_URL>/callback` registered as a
   redirect URI. If it is a different app, update the public client ID in
   `src/whop-oidc.ts` and provide its secret through your deployment's secret
   store.
4. HTTPS `MCP_BASE_URL` and the three required secrets listed above.

Keep account IDs, namespace IDs, routes, and secrets in an untracked deployment
configuration or your deployment system. The example Wrangler configuration is
not a production deployment manifest.
