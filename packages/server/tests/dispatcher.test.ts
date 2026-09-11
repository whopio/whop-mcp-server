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

	it("prepares deterministically without performing network or credential work", () => {
		const { fetch, requests } = fakeFetch();
		let credentialCalls = 0;
		const op = findOperation(registry, "payouts_create");
		const dispatcher = makeDispatcher(fetch, {
			credentialAdapter: {
				getCredential: async () => {
					credentialCalls += 1;
					return { token: "unused" };
				},
			},
		});
		const input = { amount: 500, payout_method_id: "potk_abc123" };
		const first = dispatcher.prepare(op, input, principal, {
			idempotencyKey: "approved-tool-call",
		});
		const second = dispatcher.prepare(op, input, principal, {
			idempotencyKey: "approved-tool-call",
		});

		expect(first).toEqual(second);
		expect(first).toEqual({
			args: {
				account_id: "biz_boundAccount",
				amount: 500,
				payout_method_id: "potk_abc123",
			},
			method: "POST",
			url: "https://api.whop.test/api/v1/payouts",
			body: {
				account_id: "biz_boundAccount",
				amount: 500,
				payout_method_id: "potk_abc123",
			},
			idempotencyKey: "approved-tool-call",
		});
		expect(requests).toHaveLength(0);
		expect(credentialCalls).toBe(0);
		expect(Object.isFrozen(first)).toBe(true);
		expect(Object.isFrozen(first.args)).toBe(true);
		expect(Object.isFrozen(first.body)).toBe(true);
	});

	it("dispatches the exact prepared method, URL, body, and idempotency key", async () => {
		const { fetch, requests } = fakeFetch();
		const op = findOperation(registry, "payouts_create");
		const dispatcher = makeDispatcher(fetch);
		const prepared = dispatcher.prepare(
			op,
			{ amount: 500, payout_method_id: "potk_abc123" },
			principal,
			{ idempotencyKey: "approved-tool-call" },
		);

		await dispatcher.dispatchPrepared(op, prepared, principal);

		expect(requests[0]).toMatchObject({
			method: prepared.method,
			url: prepared.url,
			body: prepared.body,
		});
		expect(requests[0].headers["idempotency-key"]).toBe(
			prepared.idempotencyKey,
		);
	});

	it("dispatches its immutable registered snapshot instead of caller mutations", async () => {
		const { fetch, requests } = fakeFetch();
		const op = findOperation(registry, "payouts_create");
		const dispatcher = makeDispatcher(fetch);
		const prepared = dispatcher.prepare(
			op,
			{ amount: 500, payout_method_id: "potk_abc123" },
			principal,
			{ idempotencyKey: "approved-tool-call" },
		);

		expect(Reflect.set(prepared, "method", "DELETE")).toBe(false);
		expect(Reflect.set(prepared, "url", "https://attacker.test/")).toBe(false);
		expect(Reflect.set(prepared, "idempotencyKey", "changed")).toBe(false);
		expect(Reflect.set(prepared.body!, "amount", 999)).toBe(false);

		await dispatcher.dispatchPrepared(op, prepared, principal);

		expect(requests[0]).toMatchObject({
			method: "POST",
			url: "https://api.whop.test/api/v1/payouts",
			body: {
				account_id: "biz_boundAccount",
				amount: 500,
				payout_method_id: "potk_abc123",
			},
		});
		expect(requests[0].headers["idempotency-key"]).toBe("approved-tool-call");
	});

	it("rejects forged, cross-dispatcher, and mismatched-operation handles", async () => {
		const { fetch, requests } = fakeFetch();
		let credentialCalls = 0;
		const dispatcher = makeDispatcher(fetch, {
			credentialAdapter: {
				getCredential: async () => {
					credentialCalls += 1;
					return { token: "unused" };
				},
			},
		});
		const op = findOperation(registry, "payouts_create");
		const prepared = dispatcher.prepare(
			op,
			{ amount: 500, payout_method_id: "potk_abc123" },
			principal,
			{ idempotencyKey: "approved-tool-call" },
		);
		const forged = { ...prepared };
		const quoteOperation = findOperation(registry, "payouts_quotes");

		await expect(
			dispatcher.dispatchPrepared(op, forged, principal),
		).rejects.toMatchObject({ code: "confirmation_invalid" });
		await expect(
			makeDispatcher(fetch).dispatchPrepared(op, prepared, principal),
		).rejects.toMatchObject({ code: "confirmation_invalid" });
		await expect(
			dispatcher.dispatchPrepared(quoteOperation, prepared, principal),
		).rejects.toMatchObject({ code: "confirmation_invalid" });
		await expect(
			dispatcher.dispatchPrepared({ ...op }, prepared, principal),
		).rejects.toMatchObject({ code: "confirmation_invalid" });
		expect(requests).toHaveLength(0);
		expect(credentialCalls).toBe(0);
	});

	it("refuses a prepared dispatch when the per-call principal lacks its scope", async () => {
		const { fetch, requests } = fakeFetch();
		const op = findOperation(registry, "payouts_create");
		const dispatcher = makeDispatcher(fetch);
		const prepared = dispatcher.prepare(
			op,
			{ amount: 500, payout_method_id: "potk_abc123" },
			principal,
			{ idempotencyKey: "approved-tool-call" },
		);

		await expect(
			dispatcher.dispatchPrepared(op, prepared, {
				...principal,
				scopes: [],
			}),
		).rejects.toMatchObject({ code: "missing_scope" });
		expect(requests).toHaveLength(0);
	});

	it("dispatches shared fields from a union request body", async () => {
		const { fetch, requests } = fakeFetch();
		const op = findOperation(registry, "payouts_create");
		await makeDispatcher(fetch).dispatch(
			op,
			{ amount: 500, payout_method_id: "potk_abc123" },
			principal,
		);
		expect(requests[0].body).toEqual({
			account_id: "biz_boundAccount",
			amount: 500,
			payout_method_id: "potk_abc123",
		});
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

	it("allows foreign biz_ IDs in non-account fields (child accounts, partners)", async () => {
		const { fetch, requests } = fakeFetch();
		const op = findOperation(registry, "accounts_get");
		await makeDispatcher(fetch).dispatch(
			op,
			{ id: "biz_childAccount" },
			principal,
		);
		expect(requests[0].url).toContain("/accounts/biz_childAccount");
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

	it("scopes extra header overrides to one dispatch", async () => {
		const { fetch, requests } = fakeFetch();
		const op = findOperation(registry, "products_list");
		const dispatcher = makeDispatcher(fetch, {
			extraHeaders: {
				"x-client-source": "connection",
				"x-shared-header": "connection",
			},
		});
		await dispatcher.dispatch(op, {}, principal, {
			extraHeaders: {
				"x-call-id": "call_123",
				"x-shared-header": "dispatch",
			},
		});
		await dispatcher.dispatch(op, {}, principal);

		expect(requests[0].headers["x-client-source"]).toBe("connection");
		expect(requests[0].headers["x-call-id"]).toBe("call_123");
		expect(requests[0].headers["x-shared-header"]).toBe("dispatch");
		expect(requests[1].headers["x-client-source"]).toBe("connection");
		expect(requests[1].headers["x-call-id"]).toBeUndefined();
		expect(requests[1].headers["x-shared-header"]).toBe("connection");
	});

	it("uses redirect handling supported by Cloudflare Workers", async () => {
		let redirect: RequestInit["redirect"];
		const edgeFetch = (async (
			_input: Parameters<typeof fetch>[0],
			init?: RequestInit,
		) => {
			redirect = init?.redirect;
			if (init?.redirect === "error") {
				throw new TypeError(
					'Invalid redirect value, must be one of "follow" or "manual"',
				);
			}
			return Response.json({ ok: true });
		}) as typeof fetch;
		const op = findOperation(registry, "products_list");

		await expect(
			makeDispatcher(edgeFetch).dispatch(op, {}, principal, {
				mcpRequestContext: {
					intent: "List my products",
					intentId: "123e4567-e89b-42d3-a456-426614174000",
					toolName: "products_list",
					toolCallId: "223e4567-e89b-42d3-a456-426614174000",
				},
			}),
		).resolves.toMatchObject({ status: 200 });
		expect(redirect).toBe("manual");
	});

	it("rejects upstream redirects without following them", async () => {
		let requestCount = 0;
		let bodyCancelled = false;
		const redirectFetch = (async (
			_input: Parameters<typeof fetch>[0],
			init?: RequestInit,
		) => {
			requestCount += 1;
			expect(init?.redirect).toBe("manual");
			const body = new ReadableStream({
				cancel() {
					bodyCancelled = true;
					throw new Error("cancel failed");
				},
			});
			return new Response(body, {
				status: 302,
				headers: {
					Location: "https://example.test/not-followed",
					"x-request-id": "req_redirect",
				},
			});
		}) as typeof fetch;
		const op = findOperation(registry, "products_list");

		await expect(
			makeDispatcher(redirectFetch).dispatch(op, {}, principal),
		).rejects.toMatchObject({
			code: "upstream_error",
			status: 302,
			requestId: "req_redirect",
		});
		expect(requestCount).toBe(1);
		expect(bodyCancelled).toBe(true);
	});

	it("scopes MCP context to one dispatch", async () => {
		const { fetch, requests } = fakeFetch();
		const op = findOperation(registry, "products_list");
		const dispatcher = makeDispatcher(fetch, {
			extraHeaders: { "x-client-source": "connection" },
		});
		await dispatcher.dispatch(op, {}, principal, {
			mcpRequestContext: {
				intent: "List my products",
				intentId: "123e4567-e89b-42d3-a456-426614174000",
				toolName: "products_list",
				toolCallId: "223e4567-e89b-42d3-a456-426614174000",
			},
		});
		await dispatcher.dispatch(op, {}, principal);
		expect(requests[0].headers["x-client-source"]).toBe("connection");
		expect(requests[0].headers["x-whop-mcp-context"]).toBeTruthy();
		expect(requests[0].redirect).toBe("manual");
		expect(requests[1].headers["x-client-source"]).toBe("connection");
		expect(requests[1].headers["x-whop-mcp-context"]).toBeUndefined();
		expect(requests[1].redirect).toBe("manual");
	});
});
