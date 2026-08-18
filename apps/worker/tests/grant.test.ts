import { describe, expect, it } from "vitest";
import { attributionHeaders } from "../src/grant.ts";
import type { Env, WhopGrantProps } from "../src/types.ts";

const env = { CF_VERSION_METADATA: { id: "test-version" } } as Env;
const props = { profile: "admin", mcpClientName: "Claude" } as WhopGrantProps;

describe("attributionHeaders", () => {
	it.each(["http", "sse"] as const)(
		"stamps hosted-worker attribution for %s",
		(transport) => {
			const headers = attributionHeaders(env, props, transport);
			expect(headers).toEqual({
				"x-whop-mcp-client": `whop-mcp-worker/test-version; profile=admin; transport=${transport}`,
				"x-whop-mcp-client-name": "Claude",
			});
		},
	);

	it("supports grants created before client attribution", () => {
		const headers = attributionHeaders(
			env,
			{ profile: "admin" } as WhopGrantProps,
			"http",
		);
		expect(headers).not.toHaveProperty("x-whop-mcp-client-name");
	});
});
