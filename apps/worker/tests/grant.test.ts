import { describe, expect, it } from "vitest";
import { attributionHeaders, normalizeMcpClientName } from "../src/grant.ts";
import type { Env, WhopGrantProps } from "../src/types.ts";

const env = { CF_VERSION_METADATA: { id: "test-version" } } as Env;
const props = { profile: "admin", mcpClientName: "Claude" } as WhopGrantProps;

describe("attributionHeaders", () => {
	it("stamps hosted-worker attribution", () => {
		const headers = attributionHeaders(env, props);
		expect(headers).toEqual({
			"x-whop-mcp-client":
				"whop-mcp-worker/test-version; profile=admin; transport=http",
			"x-whop-mcp-client-name": "Claude",
		});
	});

	it("supports grants created before client attribution", () => {
		const headers = attributionHeaders(env, {
			profile: "admin",
		} as WhopGrantProps);
		expect(headers).not.toHaveProperty("x-whop-mcp-client-name");
	});
});

describe("normalizeMcpClientName", () => {
	it("keeps one printable, bounded value for storage and headers", () => {
		expect(normalizeMcpClientName("  Claude 🦄 Code  ")).toBe("Claude  Code");
		expect(normalizeMcpClientName("a".repeat(129))).toBe("a".repeat(128));
		expect(normalizeMcpClientName("  🦄  ")).toBeUndefined();
	});
});
