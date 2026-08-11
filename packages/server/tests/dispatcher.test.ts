import { describe, expect, it } from "vitest";
import { Dispatcher } from "../src/runtime/dispatcher.ts";
import { WhopMcpError } from "../src/runtime/errors.ts";
import {
	buildRealRegistry,
	fakeFetch,
	findOperation,
	principalFixture,
	staticCredential,
} from "./helpers.ts";

const registry = buildRealRegistry();
const principal = principalFixture();

function makeDispatcher(
	fetchImpl: typeof fetch,
	overrides: Partial<ConstructorParameters<typeof Dispatcher>[0]> = {},
) {
	return new Dispatcher({
		baseUrl: "https://api.whop.test/api/v1",
		apiVersionDate: registry.meta.apiVersionDate,
		credentialAdapter: staticCredential(),
		fetch: fetchImpl,
		...overrides,
	});
}

describe("dispatcher", () => {
	it("sends credentials and the pinned API version", async () => {
		const { fetch, requests } = fakeFetch();
		const op = findOperation(registry, "products_list");
		await makeDispatcher(fetch).dispatch(op, {}, principal);
		expect(requests[0].headers.authorization).toBe("Bearer apik_testtoken1234");
		expect(requests[0].headers["api-version-date"]).toBe(
			registry.meta.apiVersionDate,
		);
	});

	it("splits path, query, and body inputs deterministically", async () => {
		const { fetch, requests } = fakeFetch();
		const op = findOperation(registry, "products_update");
		await makeDispatcher(fetch).dispatch(
			op,
			{ id: "prod_abc123", title: "New title" },
			principal,
		);
		expect(requests[0].url).toBe(
			"https://api.whop.test/api/v1/products/prod_abc123",
		);
		expect(requests[0].method).toBe("PATCH");
		expect(requests[0].body).toEqual({ title: "New title" });
	});

	it("URI-encodes and rejects traversal in path values", async () => {
		const op = findOperation(registry, "products_get");
		const dispatcher = makeDispatcher(fakeFetch().fetch);
		for (const evil of [
			"../admin",
			"..%2Fadmin",
			"a/b",
			"a\\b",
			"%2e%2e",
			"prod_x?limit=1",
			"prod_x#frag",
			"",
			".",
		]) {
			await expect(
				dispatcher.dispatch(op, { id: evil }, principal),
				JSON.stringify(evil),
			).rejects.toMatchObject({ code: "invalid_input" });
		}
	});

	it("validates ID prefixes where the resource type is known", async () => {
		const op = registry.operations.find(
			(o) => o.idPrefixes && Object.keys(o.idPrefixes).length > 0,
		);
		expect(op).toBeDefined();
		const [param, prefix] = Object.entries(op!.idPrefixes!)[0];
		const args: Record<string, unknown> = {};
		for (const p of op!.parameters) {
			if (p.in === "path")
				args[p.name] = `${op!.idPrefixes![p.name] ?? "x"}_valid123`;
		}
		args[param] = "wrongprefix_123";
		await expect(
			makeDispatcher(fakeFetch().fetch).dispatch(op!, args, principal),
		).rejects.toMatchObject({ code: "invalid_input" });
		expect(prefix).not.toBe("wrongprefix");
	});

	it("rejects undeclared input properties", async () => {
		const op = findOperation(registry, "products_list");
		await expect(
			makeDispatcher(fakeFetch().fetch).dispatch(
				op,
				{ not_a_real_param: true },
				principal,
			),
		).rejects.toMatchObject({ code: "invalid_input" });
	});

	it("injects the bound account and rejects cross-account input", async () => {
		const { fetch, requests } = fakeFetch();
		const op = findOperation(registry, "products_list");
		expect(op.accountParam).toBe("account_id");
		await makeDispatcher(fetch).dispatch(op, {}, principal);
		expect(requests[0].url).toContain("account_id=biz_boundAccount");

		await expect(
			makeDispatcher(fetch).dispatch(
				op,
				{ account_id: "biz_otherAccount" },
				principal,
			),
		).rejects.toMatchObject({ code: "account_mismatch" });
	});

	it("rejects the global sentinel when an account is bound", async () => {
		const { fetch } = fakeFetch();
		const op = findOperation(registry, "products_list");
		await expect(
			makeDispatcher(fetch).dispatch(op, { account_id: "global" }, principal),
		).rejects.toMatchObject({ code: "account_mismatch" });
	});

	it("rejects account fields nested inside objects and arrays", async () => {
		const op = registry.operations.find(
			(o) =>
				o.hasRequestBody &&
				!o.safety.confirmationRequired &&
				o.inputSchema.additionalProperties === false,
		)!;
		await expect(
			makeDispatcher(fakeFetch().fetch).dispatch(
				op,
				{ metadata: { company_id: "biz_otherAccount" } },
				principal,
			),
		).rejects.toMatchObject({ code: "account_mismatch" });
	});

	it("rejects non-string account field values", async () => {
		const op = findOperation(registry, "products_list");
		await expect(
			makeDispatcher(fakeFetch().fetch).dispatch(
				op,
				{ company_id: { nested: "biz_boundAccount" } },
				principal,
			),
		).rejects.toMatchObject({ code: "invalid_input" });
	});

	it("allows foreign biz_ IDs in non-account fields (child companies, partners)", async () => {
		const { fetch, requests } = fakeFetch();
		const op = findOperation(registry, "companies_get");
		await makeDispatcher(fetch).dispatch(
			op,
			{ id: "biz_childAccount" },
			principal,
		);
		expect(requests[0].url).toContain("/companies/biz_childAccount");
	});

	it("serializes array query params as repeated keys", async () => {
		const op = registry.operations.find(
			(o) =>
				o.method === "get" &&
				o.parameters.some((p) => p.in === "query" && p.schema.type === "array"),
		);
		expect(op).toBeDefined();
		const arrayParam = op!.parameters.find(
			(p) => p.in === "query" && p.schema.type === "array",
		)!;
		const { fetch, requests } = fakeFetch();
		const args: Record<string, unknown> = {
			[arrayParam.name]: ["a", "b"],
		};
		for (const p of op!.parameters) {
			if (p.in === "path") args[p.name] = "x_123456";
		}
		await makeDispatcher(fetch)
			.dispatch(op!, args, principal)
			.catch(() => {});
		if (requests.length > 0) {
			expect(requests[0].url).toContain(
				`${encodeURIComponent(arrayParam.name)}%5B%5D=a`.replace(
					/%5B%5D/g,
					"%5B%5D",
				),
			);
		}
	});

	it("normalizes and redacts upstream errors", async () => {
		const { fetch } = fakeFetch(() => ({
			status: 422,
			body: {
				error: {
					message: "Invalid plan. Debug token Bearer redaction-test-value",
					internal_backtrace: ["app/models/plan.rb:12"],
				},
				secrets: { api_key: "apik_realkey12345678" },
			},
		}));
		const op = findOperation(registry, "products_list");
		const error = await makeDispatcher(fetch)
			.dispatch(op, {}, principal)
			.catch((e: WhopMcpError) => e);
		expect(error).toBeInstanceOf(WhopMcpError);
		const serialized = JSON.stringify((error as WhopMcpError).toResult());
		expect(serialized).not.toContain("redaction-test-value");
		expect(serialized).not.toContain("apik_realkey12345678");
		expect(serialized).not.toContain("internal_backtrace");
		expect((error as WhopMcpError).requestId).toBe("req_test");
	});

	it("maps 401 and 403 to auth error codes", async () => {
		const op = findOperation(registry, "products_list");
		for (const [status, code] of [
			[401, "not_authenticated"],
			[403, "missing_scope"],
		] as const) {
			const { fetch } = fakeFetch(() => ({ status, body: {} }));
			await expect(
				makeDispatcher(fetch).dispatch(op, {}, principal),
			).rejects.toMatchObject({ code, status });
		}
	});

	it("times out slow upstream requests", async () => {
		const slowFetch = ((
			_input: Parameters<typeof fetch>[0],
			init?: RequestInit,
		) =>
			new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () =>
					reject(new DOMException("aborted", "AbortError")),
				);
			})) as typeof fetch;
		const op = findOperation(registry, "products_list");
		await expect(
			makeDispatcher(slowFetch, { timeoutMs: 20 }).dispatch(op, {}, principal),
		).rejects.toMatchObject({ code: "timeout" });
	});

	it("rejects oversized responses", async () => {
		const { fetch } = fakeFetch(() => ({
			body: { blob: "x".repeat(600_000) },
		}));
		const op = findOperation(registry, "products_list");
		await expect(
			makeDispatcher(fetch, { maxResponseBytes: 1000 }).dispatch(
				op,
				{},
				principal,
			),
		).rejects.toMatchObject({ code: "response_too_large" });
	});

	it("auto-injects an Idempotency-Key on operations with an idempotency policy", async () => {
		const { fetch, requests } = fakeFetch();
		const op = findOperation(registry, "products_update");
		expect(op.safety.idempotency).toBe("supported");
		await makeDispatcher(fetch).dispatch(
			op,
			{ id: "prod_abc123", title: "New title" },
			principal,
		);
		expect(requests[0].headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
	});

	it("uses the caller-provided idempotency key for confirmed operations", async () => {
		const { fetch, requests } = fakeFetch();
		const op = findOperation(registry, "payments_refund");
		expect(op.safety.financial).toBe(true);
		expect(op.safety.idempotency).toBe("required");
		await makeDispatcher(fetch).dispatch(op, { id: "pay_abc123" }, principal, {
			idempotencyKey: "confirm-jti-42",
		});
		expect(requests[0].headers["idempotency-key"]).toBe("confirm-jti-42");
	});

	it("honors an override key even when the idempotency policy is none", async () => {
		const { fetch, requests } = fakeFetch();
		const op = findOperation(registry, "memberships_cancel");
		expect(op.safety.confirmationRequired).toBe(true);
		expect(op.safety.idempotency).toBe("none");
		await makeDispatcher(fetch).dispatch(op, { id: "mem_abc123" }, principal, {
			idempotencyKey: "confirm-jti-99",
		});
		expect(requests[0].headers["idempotency-key"]).toBe("confirm-jti-99");
	});

	it("injects the bound account into parent_company_id paths", async () => {
		const { fetch, requests } = fakeFetch();
		const op = registry.operations.find(
			(o) =>
				o.path === "/companies/{parent_company_id}/api_keys" &&
				o.method === "post",
		)!;
		expect(op.accountParam).toBe("parent_company_id");
		await makeDispatcher(fetch).dispatch(
			op,
			{ name: "test key", child_company_id: "biz_childAccount" },
			principal,
		);
		expect(requests[0].url).toContain("/companies/biz_boundAccount/api_keys");
	});

	it("sends no Idempotency-Key on reads", async () => {
		const { fetch, requests } = fakeFetch();
		const op = findOperation(registry, "products_list");
		await makeDispatcher(fetch).dispatch(op, {}, principal);
		expect(requests[0].headers["idempotency-key"]).toBeUndefined();
	});

	it("forwards extra headers on every upstream request", async () => {
		const { fetch, requests } = fakeFetch();
		const op = findOperation(registry, "products_list");
		await makeDispatcher(fetch, {
			extraHeaders: { "x-client-source": "test" },
		}).dispatch(op, {}, principal);
		expect(requests[0].headers["x-client-source"]).toBe("test");
	});
});
