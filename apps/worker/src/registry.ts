import manifest from "@whop/mcp-server/manifest.json" with { type: "json" };
import type { RegistryManifest } from "@whop/mcp-server";

export const registry = manifest as unknown as RegistryManifest;
