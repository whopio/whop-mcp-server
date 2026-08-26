import type { TokenExchangeCallbackOptions } from "@cloudflare/workers-oauth-provider";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@cloudflare/workers-oauth-provider", () => ({
	GrantType: {
		AUTHORIZATION_CODE: "authorization_code",
		REFRESH_TOKEN: "refresh_token",
	},
	OAuthError: class OAuthError extends Error {
		constructor(code: string) {
			super(code);
		}
	},
}));

const { reconcileGrantOnTokenExchange } =
	await import("../src/token-exchange.ts");
import type { WhopGrantProps } from "../src/types.ts";
import { WhopOidcError } from "../src/whop-oidc.ts";

const NOW = 2_000_000_000_000;

const LEGACY_PROPS: WhopGrantProps = {
	userId: "user_test",
	userName: null,
	profile: "admin",
	whopAccessToken: "access_old",
	whopRefreshToken: "refresh_old",
	whopExpiresAt: NOW + 5 * 60 * 1000,
};

function options(
	props: WhopGrantProps = LEGACY_PROPS,
): TokenExchangeCallbackOptions {
	return {
		grantType: "refresh_token" as TokenExchangeCallbackOptions["grantType"],
		clientId: "client_test",
		userId: "user_test",
		grantId: "grant_test",
		scope: ["admin"],
		requestedScope: ["admin"],
		props,
	};
}

function dependencies() {
	return {
		lookupClient: vi.fn(async () => ({ clientName: "Claude Code" })),
		now: () => NOW,
		refreshWhop: vi.fn(async () => ({
			accessToken: "access_new",
			refreshToken: "refresh_new",
			expiresAt: NOW + 60 * 60 * 1000,
		})),
	};
}

afterEach(() => vi.restoreAllMocks());

describe("reconcileGrantOnTokenExchange", () => {
	it("backfills a legacy grant while rotating its Whop credential", async () => {
		const deps = dependencies();
		const result = await reconcileGrantOnTokenExchange(options(), deps);

		expect(deps.lookupClient).toHaveBeenCalledWith("client_test");
		expect(deps.refreshWhop).toHaveBeenCalledWith("refresh_old");
		expect(deps.lookupClient.mock.invocationCallOrder[0]).toBeLessThan(
			deps.refreshWhop.mock.invocationCallOrder[0],
		);
		expect(result?.newProps).toEqual({
			...LEGACY_PROPS,
			mcpClientName: "Claude Code",
			whopAccessToken: "access_new",
			whopRefreshToken: "refresh_new",
			whopExpiresAt: NOW + 60 * 60 * 1000,
		});
	});

	it("preserves an existing client name without another lookup", async () => {
		const deps = dependencies();
		const result = await reconcileGrantOnTokenExchange(
			options({ ...LEGACY_PROPS, mcpClientName: "Cursor" }),
			deps,
		);

		expect(deps.lookupClient).not.toHaveBeenCalled();
		expect(result?.newProps).toMatchObject({ mcpClientName: "Cursor" });
	});

	it("does no work before the Whop credential needs rotation", async () => {
		const deps = dependencies();
		const result = await reconcileGrantOnTokenExchange(
			options({
				...LEGACY_PROPS,
				whopExpiresAt: NOW + 60 * 60 * 1000,
			}),
			deps,
		);

		expect(result).toBeUndefined();
		expect(deps.lookupClient).not.toHaveBeenCalled();
		expect(deps.refreshWhop).not.toHaveBeenCalled();
	});

	it("keeps token rotation available when client lookup fails", async () => {
		const deps = dependencies();
		deps.lookupClient.mockRejectedValueOnce(new Error("KV unavailable"));
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

		const result = await reconcileGrantOnTokenExchange(options(), deps);

		expect(result?.newProps).toEqual({
			...LEGACY_PROPS,
			whopAccessToken: "access_new",
			whopRefreshToken: "refresh_new",
			whopExpiresAt: NOW + 60 * 60 * 1000,
		});
		expect(warn).toHaveBeenCalledOnce();
	});

	it("rotates credentials when the registered client has no usable name", async () => {
		const deps = dependencies();
		deps.lookupClient.mockResolvedValueOnce({ clientName: "  🦄  " });

		const result = await reconcileGrantOnTokenExchange(options(), deps);

		expect(result?.newProps).not.toHaveProperty("mcpClientName");
		expect(result?.newProps).toMatchObject({
			whopAccessToken: "access_new",
			whopRefreshToken: "refresh_new",
		});
	});

	it("maps a terminal upstream refresh failure to invalid_grant", async () => {
		const deps = dependencies();
		deps.refreshWhop.mockRejectedValueOnce(new WhopOidcError("expired", 401));
		vi.spyOn(console, "log").mockImplementation(() => undefined);

		await expect(
			reconcileGrantOnTokenExchange(options(), deps),
		).rejects.toThrow("invalid_grant");
		expect(deps.lookupClient).toHaveBeenCalledOnce();
	});

	it("ignores token exchanges that are not refreshes", async () => {
		const deps = dependencies();
		const result = await reconcileGrantOnTokenExchange(
			{
				...options(),
				grantType:
					"authorization_code" as TokenExchangeCallbackOptions["grantType"],
			},
			deps,
		);

		expect(result).toBeUndefined();
		expect(deps.lookupClient).not.toHaveBeenCalled();
		expect(deps.refreshWhop).not.toHaveBeenCalled();
	});
});
