import { describe, expect, it } from "vitest";
import {
	attributionHeaders,
	grantedScopes,
	normalizeMcpClientName,
	parseGrantProps,
	principalFromProps,
} from "../src/grant.ts";
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

it("refuses pre-consent access tokens even before they expire", () => {
	const legacy = {
		whopScope: "openid profile",
		userId: "user_test",
		profile: "admin",
		whopAccessToken: "access",
		whopRefreshToken: "refresh",
		whopExpiresAt: Date.now() + 3600000,
	};
	expect(parseGrantProps(legacy)).toBeNull();
	expect(parseGrantProps({ ...legacy, consentVersion: 1 })).not.toBeNull();
});

describe("grantedScopes", () => {
	it("splits, dedupes, and sorts the granted scope string", () => {
		expect(
			grantedScopes("  payment:basic:read openid\topenid  ai_chat:read "),
		).toEqual(["ai_chat:read", "openid", "payment:basic:read"]);
	});
});

describe("principalFromProps", () => {
	it("carries the scopes Whop granted instead of a wildcard", () => {
		const principal = principalFromProps({
			...props,
			userId: "user_1",
			whopScope: "openid payment:basic:read",
		} as WhopGrantProps);
		expect(principal.scopes).toEqual(["openid", "payment:basic:read"]);
		expect(principal.scopes).not.toContain("*");
		expect(principal.accountId).toBeNull();
	});
});
