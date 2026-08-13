import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import type { PrincipalContext } from "../src/policy/types.ts";
import { InMemoryAuditSink } from "../src/safety/audit.ts";
import { WhopMcpError } from "../src/runtime/errors.ts";
import { InMemoryIdempotencyStore } from "../src/safety/idempotency.ts";
import { createWhopMcpServer } from "../src/runtime/server.ts";
import {
	buildRealRegistry,
	fakeFetch,
	principalFixture,
	staticCredential,
} from "./helpers.ts";

const registry = buildRealRegistry();
const SECRET = "test-secret-key-that-is-long-enough";

class FailFirstCompletionStore extends InMemoryIdempotencyStore {
	#failNextCompletion = true;

	override async complete(
		key: string,
		ownerId: string,
		result: unknown,
		completedAt: string,
	) {
		if (this.#failNextCompletion) {
			this.#failNextCompletion = false;
			throw new Error("completion storage unavailable");
		}
		return super.complete(key, ownerId, result, completedAt);
	}
}

class CommitThenFailCompletionStore extends InMemoryIdempotencyStore {
	#failNextCallerCompletion = true;
	#hideCommittedResultOnce: boolean;

	constructor(hideCommittedResultOnce = false) {
		super();
		this.#hideCommittedResultOnce = hideCommittedResultOnce;
	}

	override async get(key: string) {
		if (this.#hideCommittedResultOnce && !key.startsWith("confirmation:")) {
			this.#hideCommittedResultOnce = false;
			throw new Error("completion read unavailable");
		}
		return super.get(key);
	}

	override async complete(
		key: string,
		ownerId: string,
		result: unknown,
		completedAt: string,
	) {
		const completion = await super.complete(key, ownerId, result, completedAt);
		if (this.#failNextCallerCompletion && !key.startsWith("confirmation:")) {
			this.#failNextCallerCompletion = false;
			throw new Error("completion response lost after commit");
		}
		return completion;
	}
}

class FailFirstCallerClaimStore extends InMemoryIdempotencyStore {
	#failNextCallerClaim = true;

	override async claim(...args: Parameters<InMemoryIdempotencyStore["claim"]>) {
		if (this.#failNextCallerClaim && !args[0].startsWith("confirmation:")) {
			this.#failNextCallerClaim = false;
			throw new Error("caller reservation unavailable");
		}
		return super.claim(...args);
	}
}

class OrphanedCallerReservationStore extends InMemoryIdempotencyStore {
	override async claim(
		key: string,
		input: Parameters<InMemoryIdempotencyStore["claim"]>[1],
		options: Parameters<InMemoryIdempotencyStore["claim"]>[2],
	) {
		if (!key.startsWith("confirmation:") && !(await this.get(key))) {
			await super.claim(
				key,
				{ ...input, ownerId: "orphaned-owner" },
				{ takeoverIncomplete: false },
			);
		}
		return super.claim(key, input, options);
	}
}

async function connect(
	options: {
		principal?: PrincipalContext;
		fetch?: typeof fetch;
		auditSink?: InMemoryAuditSink;
		idempotencyStore?: InMemoryIdempotencyStore;
		beforeCall?: Parameters<typeof createWhopMcpServer>[0]["beforeCall"];
	} = {},
) {
	const { server } = createWhopMcpServer({
		registry,
		credentialAdapter: staticCredential(),
		principal: options.principal ?? principalFixture(),
		confirmationSecret: SECRET,
		fetch: options.fetch ?? fakeFetch().fetch,
		auditSink: options.auditSink,
		idempotencyStore: options.idempotencyStore,
		beforeCall: options.beforeCall,
		baseUrl: "https://api.whop.test/api/v1",
	});
	const client = new Client({ name: "test-client", version: "1.0.0" });
	const [clientTransport, serverTransport] =
		InMemoryTransport.createLinkedPair();
	await Promise.all([
		server.connect(serverTransport),
		client.connect(clientTransport),
	]);
	return client;
}

function parseResult(result: unknown): Record<string, unknown> {
	const content = (result as { content: { type: string; text: string }[] })
		.content;
	return JSON.parse(content[0].text);
}

describe("MCP contract", () => {
	it("initializes and lists tools including connection_status", async () => {
		const client = await connect();
		const { tools } = await client.listTools();
		const names = tools.map((t) => t.name);
		expect(names).toContain("accounts_me");
		expect(names).toContain("connection_status");
		expect(names).toContain("payments_refund");
		const businessOps = registry.operations.filter((op) =>
			op.principals.includes("business"),
		);
		expect(tools.length).toBe(businessOps.length + 1);
	});

	it("filters tools by permission profile", async () => {
		const client = await connect({
			principal: principalFixture({ permissionProfile: "read_only" }),
		});
		const { tools } = await client.listTools();
		const registryTools = tools.filter((t) => t.name !== "connection_status");
		expect(registryTools.length).toBeGreaterThan(100);
		for (const tool of registryTools) {
			expect(tool.annotations?.readOnlyHint, tool.name).toBe(true);
		}
	});

	it("filters tools by granted scopes", async () => {
		const granted = ["company:basic:read"];
		const client = await connect({
			principal: principalFixture({
				permissionProfile: "admin",
				scopes: granted,
			}),
		});
		const { tools } = await client.listTools();
		expect(tools.length).toBeLessThan(registry.operations.length + 1);
		for (const tool of tools) {
			if (tool.name === "connection_status") continue;
			const op = registry.operations.find((o) => o.toolName === tool.name)!;
			expect(
				op.scopeAlternatives.some((alternative) =>
					alternative.every((scope) => granted.includes(scope)),
				),
				tool.name,
			).toBe(true);
		}
	});

	it("shows a tool when one OpenAPI scope alternative is granted", async () => {
		const client = await connect({
			principal: principalFixture({
				permissionProfile: "standard",
				scopes: ["support_chat:message:create"],
			}),
		});
		const { tools } = await client.listTools();
		expect(tools.map((tool) => tool.name)).toContain("messages_create");
		expect(tools.map((tool) => tool.name)).not.toContain("messages_delete");
	});

	it("requires every scope within an OpenAPI alternative", async () => {
		const client = await connect({
			principal: principalFixture({
				permissionProfile: "standard",
				scopes: ["support_chat:message:create", "support_chat:read"],
			}),
		});
		const { tools } = await client.listTools();
		expect(tools.map((tool) => tool.name)).toContain("messages_delete");
	});

	it("executes a read tool against the API", async () => {
		const { fetch, requests } = fakeFetch(() => ({
			body: { data: [{ id: "prod_1" }] },
		}));
		const client = await connect({ fetch });
		const result = await client.callTool({
			name: "products_list",
			arguments: {},
		});
		expect(parseResult(result)).toEqual({ data: [{ id: "prod_1" }] });
		expect(requests[0].url).toContain("/products");
	});

	it("returns a structured error for unknown tools", async () => {
		const client = await connect();
		const result = await client.callTool({
			name: "not_a_tool",
			arguments: {},
		});
		expect(result.isError).toBe(true);
		expect(parseResult(result)).toMatchObject({
			error: { code: "tool_not_found" },
		});
	});

	it("prepares then executes a financial mutation exactly once", async () => {
		const { fetch, requests } = fakeFetch(() => ({
			body: { id: "pay_1", status: "refunded" },
		}));
		const auditSink = new InMemoryAuditSink();
		const idempotencyStore = new InMemoryIdempotencyStore();
		const client = await connect({ fetch, auditSink, idempotencyStore });

		const args = { id: "pay_123456" };
		const prepared = parseResult(
			await client.callTool({ name: "payments_refund", arguments: args }),
		);
		expect(prepared.prepared).toBe(true);
		expect(prepared.executed).toBe(false);
		expect(requests.length).toBe(0);
		const token = prepared.mcp_confirmation_token as string;
		expect(token.length).toBeGreaterThan(20);

		const executed = parseResult(
			await client.callTool({
				name: "payments_refund",
				arguments: {
					...args,
					mcp_confirmation_token: token,
					idempotency_key: "retry-1",
				},
			}),
		);
		expect(executed).toEqual({ id: "pay_1", status: "refunded" });
		expect(requests.length).toBe(1);

		const replayed = parseResult(
			await client.callTool({
				name: "payments_refund",
				arguments: {
					...args,
					mcp_confirmation_token: token,
					idempotency_key: "retry-1",
				},
			}),
		);
		expect(replayed).toEqual({ id: "pay_1", status: "refunded" });
		expect(requests.length).toBe(1);

		const outcomes = auditSink.events.map((e) => e.outcome);
		expect(outcomes).toContain("prepared");
		expect(outcomes).toContain("executed");
	});

	it("keeps API and MCP confirmation tokens distinct", async () => {
		const operation = registry.operations.find(
			(op) => op.method === "post" && op.path === "/setup_intents",
		)!;
		const { fetch, requests } = fakeFetch(() => ({
			body: { id: "sint_1", status: "requires_action" },
		}));
		const client = await connect({ fetch });
		const args = { confirmation_token: "ctok_buyer_method" };
		const { tools } = await client.listTools();
		const tool = tools.find(
			(candidate) => candidate.name === operation.toolName,
		)!;
		const properties = (
			tool.inputSchema as { properties: Record<string, unknown> }
		).properties;
		expect(properties).toHaveProperty("confirmation_token");
		expect(properties).toHaveProperty("mcp_confirmation_token");

		const prepared = parseResult(
			await client.callTool({ name: operation.toolName, arguments: args }),
		);
		expect(prepared.arguments).toMatchObject(args);
		expect(prepared.mcp_confirmation_token).toEqual(expect.any(String));

		const result = parseResult(
			await client.callTool({
				name: operation.toolName,
				arguments: {
					...args,
					mcp_confirmation_token: prepared.mcp_confirmation_token,
					idempotency_key: "setup-intent-1",
				},
			}),
		);
		expect(result).toEqual({ id: "sint_1", status: "requires_action" });
		expect(requests).toHaveLength(1);
		expect(requests[0].body).toMatchObject({
			company_id: "biz_boundAccount",
			confirmation_token: "ctok_buyer_method",
		});
		expect(requests[0].body).not.toHaveProperty("mcp_confirmation_token");
	});

	it("executes with the injected arguments a prepare returned", async () => {
		const { fetch, requests } = fakeFetch(() => ({
			body: { id: "pay_new", status: "paid" },
		}));
		const client = await connect({ fetch });

		const prepared = parseResult(
			await client.callTool({
				name: "payments_create",
				arguments: {
					plan_id: "plan_test1234",
					member_id: "mem_test1234",
					payment_method_id: "pm_test1234",
				},
			}),
		);
		expect(prepared.prepared, JSON.stringify(prepared)).toBe(true);
		const injected = prepared.arguments as Record<string, unknown>;
		expect(injected.company_id).toBe("biz_boundAccount");

		// The client follows next_step literally: it resubmits the returned
		// (account-injected) arguments, not its original pre-injection shape.
		const executed = parseResult(
			await client.callTool({
				name: "payments_create",
				arguments: {
					...injected,
					mcp_confirmation_token: prepared.mcp_confirmation_token,
					idempotency_key: "inj-1",
				},
			}),
		);
		expect(executed).toEqual({ id: "pay_new", status: "paid" });
		expect(requests.length).toBe(1);
	});

	it("replays instead of re-executing when a used token is retried (lost response)", async () => {
		const { fetch, requests } = fakeFetch(() => ({
			body: { id: "pay_1", status: "refunded" },
		}));
		const client = await connect({ fetch });

		const args = { id: "pay_123456" };
		const prepared = parseResult(
			await client.callTool({ name: "payments_refund", arguments: args }),
		);
		const token = prepared.mcp_confirmation_token as string;

		await client.callTool({
			name: "payments_refund",
			arguments: {
				...args,
				mcp_confirmation_token: token,
				idempotency_key: "k1",
			},
		});
		expect(requests.length).toBe(1);

		// Same token and key again (client never saw the success): cached result,
		// no second execution.
		const reused = parseResult(
			await client.callTool({
				name: "payments_refund",
				arguments: {
					...args,
					mcp_confirmation_token: token,
					idempotency_key: "k1",
				},
			}),
		);
		expect(reused).toEqual({ id: "pay_1", status: "refunded" });
		expect(requests.length).toBe(1);

		const changedKey = await client.callTool({
			name: "payments_refund",
			arguments: {
				...args,
				mcp_confirmation_token: token,
				idempotency_key: "k2",
			},
		});
		expect(changedKey.isError).toBe(true);
		expect(parseResult(changedKey)).toMatchObject({
			error: { code: "confirmation_invalid" },
		});
		expect(requests.length).toBe(1);
	});

	it("replays instead of re-executing on re-prepare with the same idempotency key", async () => {
		const { fetch, requests } = fakeFetch(() => ({
			body: { id: "pay_1", status: "refunded" },
		}));
		const client = await connect({ fetch });

		const args = { id: "pay_123456" };
		const first = parseResult(
			await client.callTool({ name: "payments_refund", arguments: args }),
		);
		await client.callTool({
			name: "payments_refund",
			arguments: {
				...args,
				mcp_confirmation_token: first.mcp_confirmation_token,
				idempotency_key: "stable-key",
			},
		});
		expect(requests.length).toBe(1);

		// Agent lost track, prepares again (new jti), reuses its stable key:
		// the caller-key cache short-circuits — the mutation never runs twice.
		const second = parseResult(
			await client.callTool({ name: "payments_refund", arguments: args }),
		);
		const replayed = parseResult(
			await client.callTool({
				name: "payments_refund",
				arguments: {
					...args,
					mcp_confirmation_token: second.mcp_confirmation_token,
					idempotency_key: "stable-key",
				},
			}),
		);
		expect(replayed).toEqual({ id: "pay_1", status: "refunded" });
		expect(requests.length).toBe(1);

		const reusedConfirmation = await client.callTool({
			name: "payments_refund",
			arguments: {
				...args,
				mcp_confirmation_token: second.mcp_confirmation_token,
				idempotency_key: "another-key",
			},
		});
		expect(reusedConfirmation.isError).toBe(true);
		expect(parseResult(reusedConfirmation)).toMatchObject({
			error: { code: "confirmation_invalid" },
		});
		expect(requests.length).toBe(1);
	});

	it.each([
		["the original confirmation token", false],
		["a newly prepared confirmation token", true],
	])(
		"reconciles a lost completion write with %s",
		async (_scenario, reprepare) => {
			const effects = new Map<string, Record<string, unknown>>();
			const { fetch, requests } = fakeFetch((request) => {
				const key = request.headers["idempotency-key"];
				let body = effects.get(key);
				if (!body) {
					body = { id: "mem_123456", status: "canceled" };
					effects.set(key, body);
				}
				return { body };
			});
			const client = await connect({
				fetch,
				idempotencyStore: new FailFirstCompletionStore(),
			});
			const args = { id: "mem_123456" };
			const prepared = parseResult(
				await client.callTool({ name: "memberships_cancel", arguments: args }),
			);
			const first = await client.callTool({
				name: "memberships_cancel",
				arguments: {
					...args,
					mcp_confirmation_token: prepared.mcp_confirmation_token,
					idempotency_key: "lost-completion",
				},
			});
			expect(first.isError).toBe(true);

			const mcpConfirmationToken = reprepare
				? parseResult(
						await client.callTool({
							name: "memberships_cancel",
							arguments: args,
						}),
					).mcp_confirmation_token
				: prepared.mcp_confirmation_token;
			const recovered = parseResult(
				await client.callTool({
					name: "memberships_cancel",
					arguments: {
						...args,
						mcp_confirmation_token: mcpConfirmationToken,
						idempotency_key: "lost-completion",
					},
				}),
			);

			expect(recovered).toEqual({
				id: "mem_123456",
				status: "canceled",
			});
			expect(requests).toHaveLength(2);
			expect(effects.size).toBe(1);
			expect(requests[1].headers["idempotency-key"]).toBe(
				requests[0].headers["idempotency-key"],
			);
		},
	);

	it("returns a committed result when the completion response is lost", async () => {
		const { fetch, requests } = fakeFetch(() => ({
			body: { id: "pay_123456", status: "refunded" },
		}));
		const client = await connect({
			fetch,
			idempotencyStore: new CommitThenFailCompletionStore(),
		});
		const args = { id: "pay_123456" };
		const prepared = parseResult(
			await client.callTool({ name: "payments_refund", arguments: args }),
		);
		const executionArgs = {
			...args,
			mcp_confirmation_token: prepared.mcp_confirmation_token,
			idempotency_key: "commit-then-fail",
		};

		expect(
			parseResult(
				await client.callTool({
					name: "payments_refund",
					arguments: executionArgs,
				}),
			),
		).toEqual({ id: "pay_123456", status: "refunded" });
		expect(
			parseResult(
				await client.callTool({
					name: "payments_refund",
					arguments: executionArgs,
				}),
			),
		).toEqual({ id: "pay_123456", status: "refunded" });
		expect(requests).toHaveLength(1);
	});

	it("recovers a committed caller result behind an unknown confirmation", async () => {
		const { fetch, requests } = fakeFetch(() => ({
			body: { id: "pay_123456", status: "refunded" },
		}));
		const client = await connect({
			fetch,
			idempotencyStore: new CommitThenFailCompletionStore(true),
		});
		const args = { id: "pay_123456" };
		const prepared = parseResult(
			await client.callTool({ name: "payments_refund", arguments: args }),
		);
		const executionArgs = {
			...args,
			mcp_confirmation_token: prepared.mcp_confirmation_token,
			idempotency_key: "hidden-commit",
		};
		const first = await client.callTool({
			name: "payments_refund",
			arguments: executionArgs,
		});
		expect(first.isError).toBe(true);
		expect(parseResult(first)).toMatchObject({
			error: { code: "outcome_unknown" },
		});

		expect(
			parseResult(
				await client.callTool({
					name: "payments_refund",
					arguments: executionArgs,
				}),
			),
		).toEqual({ id: "pay_123456", status: "refunded" });
		expect(requests).toHaveLength(1);
	});

	it("recovers when caller reservation fails after the confirmation is bound", async () => {
		const { fetch, requests } = fakeFetch(() => ({
			body: { id: "mem_123456", status: "canceled" },
		}));
		const client = await connect({
			fetch,
			idempotencyStore: new FailFirstCallerClaimStore(),
		});
		const args = { id: "mem_123456" };
		const prepared = parseResult(
			await client.callTool({ name: "memberships_cancel", arguments: args }),
		);
		const first = await client.callTool({
			name: "memberships_cancel",
			arguments: {
				...args,
				mcp_confirmation_token: prepared.mcp_confirmation_token,
				idempotency_key: "claim-gap",
			},
		});
		expect(first.isError).toBe(true);
		expect(requests).toHaveLength(0);

		const recovered = parseResult(
			await client.callTool({
				name: "memberships_cancel",
				arguments: {
					...args,
					mcp_confirmation_token: prepared.mcp_confirmation_token,
					idempotency_key: "claim-gap",
				},
			}),
		);
		expect(recovered).toEqual({
			id: "mem_123456",
			status: "canceled",
		});
		expect(requests).toHaveLength(1);

		const changedKey = await client.callTool({
			name: "memberships_cancel",
			arguments: {
				...args,
				mcp_confirmation_token: prepared.mcp_confirmation_token,
				idempotency_key: "different-claim-gap",
			},
		});
		expect(changedKey.isError).toBe(true);
		expect(parseResult(changedKey)).toMatchObject({
			error: { code: "confirmation_invalid" },
		});
		expect(requests).toHaveLength(1);
	});

	it("keeps a native POST bound to its upstream key after an ambiguous dispatch error", async () => {
		const effects = new Map<string, Record<string, unknown>>();
		let failFirstRequest = true;
		const { fetch, requests } = fakeFetch((request) => {
			const key = request.headers["idempotency-key"];
			let body = effects.get(key);
			if (!body) {
				body = { id: "mem_123456", status: "canceled" };
				effects.set(key, body);
			}
			if (failFirstRequest) {
				failFirstRequest = false;
				throw new Error("connection lost after execution");
			}
			return { body };
		});
		const client = await connect({ fetch });
		const args = { id: "mem_123456" };
		const prepared = parseResult(
			await client.callTool({ name: "memberships_cancel", arguments: args }),
		);
		const first = await client.callTool({
			name: "memberships_cancel",
			arguments: {
				...args,
				mcp_confirmation_token: prepared.mcp_confirmation_token,
				idempotency_key: "ambiguous-dispatch",
			},
		});
		expect(first.isError).toBe(true);

		const changedKey = await client.callTool({
			name: "memberships_cancel",
			arguments: {
				...args,
				mcp_confirmation_token: prepared.mcp_confirmation_token,
				idempotency_key: "different-key",
			},
		});
		expect(changedKey.isError).toBe(true);
		expect(parseResult(changedKey)).toMatchObject({
			error: { code: "confirmation_invalid" },
		});

		const recovered = parseResult(
			await client.callTool({
				name: "memberships_cancel",
				arguments: {
					...args,
					mcp_confirmation_token: prepared.mcp_confirmation_token,
					idempotency_key: "ambiguous-dispatch",
				},
			}),
		);
		expect(recovered).toEqual({
			id: "mem_123456",
			status: "canceled",
		});
		expect(requests).toHaveLength(2);
		expect(effects.size).toBe(1);
		expect(requests[1].headers["idempotency-key"]).toBe(
			requests[0].headers["idempotency-key"],
		);
	});

	it("does not let stale pre-dispatch cleanup erase a concurrent completion", async () => {
		let enterFirstHook!: () => void;
		let releaseFirstHook!: () => void;
		const firstHookEntered = new Promise<void>((resolve) => {
			enterFirstHook = resolve;
		});
		const firstHookReleased = new Promise<void>((resolve) => {
			releaseFirstHook = resolve;
		});
		let hookCalls = 0;
		const beforeCall = async () => {
			hookCalls += 1;
			if (hookCalls !== 1) return;
			enterFirstHook();
			await firstHookReleased;
			throw new WhopMcpError("missing_scope", "Blocked after takeover.");
		};
		const { fetch, requests } = fakeFetch(() => ({
			body: { id: "mem_123456", status: "canceled" },
		}));
		const idempotencyStore = new InMemoryIdempotencyStore();
		const firstClient = await connect({
			fetch,
			idempotencyStore,
			beforeCall,
		});
		const retryClient = await connect({
			fetch,
			idempotencyStore,
			beforeCall,
		});
		const args = { id: "mem_123456" };
		const prepared = parseResult(
			await firstClient.callTool({
				name: "memberships_cancel",
				arguments: args,
			}),
		);
		const executionArgs = {
			...args,
			mcp_confirmation_token: prepared.mcp_confirmation_token,
			idempotency_key: "concurrent-key",
		};
		const firstExecution = firstClient.callTool({
			name: "memberships_cancel",
			arguments: executionArgs,
		});
		await firstHookEntered;

		const recovered = parseResult(
			await retryClient.callTool({
				name: "memberships_cancel",
				arguments: executionArgs,
			}),
		);
		expect(recovered).toEqual({
			id: "mem_123456",
			status: "canceled",
		});
		releaseFirstHook();
		const blocked = await firstExecution;
		expect(blocked.isError).toBe(true);
		expect(parseResult(blocked)).toMatchObject({
			error: { code: "missing_scope" },
		});

		const changedKey = await retryClient.callTool({
			name: "memberships_cancel",
			arguments: {
				...args,
				mcp_confirmation_token: prepared.mcp_confirmation_token,
				idempotency_key: "concurrent-key-2",
			},
		});
		expect(changedKey.isError).toBe(true);
		expect(parseResult(changedKey)).toMatchObject({
			error: { code: "confirmation_invalid" },
		});
		expect(requests).toHaveLength(1);
	});

	it("reports a concurrent non-replayable execution as unfinished", async () => {
		let enterFirstHook!: () => void;
		let releaseFirstHook!: () => void;
		const firstHookEntered = new Promise<void>((resolve) => {
			enterFirstHook = resolve;
		});
		const firstHookReleased = new Promise<void>((resolve) => {
			releaseFirstHook = resolve;
		});
		const beforeCall = async () => {
			enterFirstHook();
			await firstHookReleased;
		};
		const { fetch, requests } = fakeFetch(() => ({
			body: { id: "ad_123456", deleted: true },
		}));
		const idempotencyStore = new InMemoryIdempotencyStore();
		const firstClient = await connect({ fetch, idempotencyStore, beforeCall });
		const retryClient = await connect({ fetch, idempotencyStore, beforeCall });
		const args = { id: "ad_123456" };
		const prepared = parseResult(
			await firstClient.callTool({
				name: "ad-campaigns_delete",
				arguments: args,
			}),
		);
		const executionArgs = {
			...args,
			mcp_confirmation_token: prepared.mcp_confirmation_token,
			idempotency_key: "non-replayable-concurrent",
		};
		const firstExecution = firstClient.callTool({
			name: "ad-campaigns_delete",
			arguments: executionArgs,
		});
		await firstHookEntered;

		const concurrent = await retryClient.callTool({
			name: "ad-campaigns_delete",
			arguments: executionArgs,
		});
		expect(concurrent.isError).toBe(true);
		expect(parseResult(concurrent)).toMatchObject({
			error: {
				code: "idempotency_conflict",
				message: expect.stringMatching(
					/unfinished.*same mcp_confirmation_token/i,
				),
			},
		});
		expect(requests).toHaveLength(0);

		releaseFirstHook();
		expect(parseResult(await firstExecution)).toEqual({
			id: "ad_123456",
			deleted: true,
		});
		expect(requests).toHaveLength(1);
	});

	it("does not describe an orphaned non-replayable reservation as active", async () => {
		const { fetch, requests } = fakeFetch(() => ({
			body: { id: "ad_123456", deleted: true },
		}));
		const client = await connect({
			fetch,
			idempotencyStore: new OrphanedCallerReservationStore(),
		});
		const args = { id: "ad_123456" };
		const prepared = parseResult(
			await client.callTool({
				name: "ad-campaigns_delete",
				arguments: args,
			}),
		);

		const result = await client.callTool({
			name: "ad-campaigns_delete",
			arguments: {
				...args,
				mcp_confirmation_token: prepared.mcp_confirmation_token,
				idempotency_key: "orphaned-non-replayable",
			},
		});

		expect(result.isError).toBe(true);
		expect(parseResult(result)).toMatchObject({
			error: {
				code: "idempotency_conflict",
				message: expect.stringMatching(
					/may still be in flight.*verify.*do not prepare/i,
				),
			},
		});
		expect(requests).toHaveLength(0);
	});

	it.each([
		[
			"a legacy POST after re-preparation",
			"payments_refund",
			"pay_123456",
			true,
		],
		[
			"a native DELETE with the original token",
			"ad-campaigns_delete",
			"ad_123456",
			false,
		],
	])(
		"fails closed for %s when completion storage is lost",
		async (_scenario, toolName, id, reprepare) => {
			const { fetch, requests } = fakeFetch(() => ({ body: { id } }));
			const client = await connect({
				fetch,
				idempotencyStore: new FailFirstCompletionStore(),
			});
			const args = { id };
			const prepared = parseResult(
				await client.callTool({ name: toolName, arguments: args }),
			);
			const first = await client.callTool({
				name: toolName,
				arguments: {
					...args,
					mcp_confirmation_token: prepared.mcp_confirmation_token,
					idempotency_key: `lost-${toolName}`,
				},
			});
			expect(first.isError).toBe(true);
			expect(parseResult(first)).toMatchObject({
				error: { code: "outcome_unknown" },
			});

			const mcpConfirmationToken = reprepare
				? parseResult(
						await client.callTool({ name: toolName, arguments: args }),
					).mcp_confirmation_token
				: prepared.mcp_confirmation_token;
			const retried = await client.callTool({
				name: toolName,
				arguments: {
					...args,
					mcp_confirmation_token: mcpConfirmationToken,
					idempotency_key: `lost-${toolName}`,
				},
			});

			expect(retried.isError).toBe(true);
			expect(parseResult(retried)).toMatchObject({
				error: {
					code: "outcome_unknown",
					message: expect.stringMatching(/verify/i),
				},
			});
			expect(requests).toHaveLength(1);

			const bypass = await client.callTool({
				name: toolName,
				arguments: {
					...args,
					mcp_confirmation_token: mcpConfirmationToken,
					idempotency_key: `replacement-${toolName}`,
				},
			});
			expect(bypass.isError).toBe(true);
			expect(parseResult(bypass)).toMatchObject({
				error: { code: "confirmation_invalid" },
			});
			expect(requests).toHaveLength(1);
		},
	);

	it("rejects execution when arguments changed after preparation", async () => {
		const client = await connect();
		const prepared = parseResult(
			await client.callTool({
				name: "payments_refund",
				arguments: { id: "pay_123456" },
			}),
		);
		const result = await client.callTool({
			name: "payments_refund",
			arguments: {
				id: "pay_999999",
				mcp_confirmation_token: prepared.mcp_confirmation_token,
				idempotency_key: "k1",
			},
		});
		expect(result.isError).toBe(true);
		expect(parseResult(result)).toMatchObject({
			error: { code: "confirmation_invalid" },
		});
	});

	it("requires an idempotency key to execute financial mutations", async () => {
		const client = await connect();
		const prepared = parseResult(
			await client.callTool({
				name: "payments_refund",
				arguments: { id: "pay_123456" },
			}),
		);
		const result = await client.callTool({
			name: "payments_refund",
			arguments: {
				id: "pay_123456",
				mcp_confirmation_token: prepared.mcp_confirmation_token,
			},
		});
		expect(result.isError).toBe(true);
		expect(parseResult(result)).toMatchObject({
			error: { code: "invalid_input" },
		});
	});

	it("rejects reuse of an idempotency key with different arguments", async () => {
		const idempotencyStore = new InMemoryIdempotencyStore();
		const client = await connect({ idempotencyStore });

		const prepare = async (id: string) =>
			parseResult(
				await client.callTool({
					name: "payments_refund",
					arguments: { id },
				}),
			);

		const first = await prepare("pay_123456");
		await client.callTool({
			name: "payments_refund",
			arguments: {
				id: "pay_123456",
				mcp_confirmation_token: first.mcp_confirmation_token,
				idempotency_key: "shared-key",
			},
		});

		const second = await prepare("pay_654321");
		const conflict = await client.callTool({
			name: "payments_refund",
			arguments: {
				id: "pay_654321",
				mcp_confirmation_token: second.mcp_confirmation_token,
				idempotency_key: "shared-key",
			},
		});
		expect(conflict.isError).toBe(true);
		expect(parseResult(conflict)).toMatchObject({
			error: { code: "idempotency_conflict" },
		});
	});

	it("rejects cross-account input through the full stack", async () => {
		const client = await connect();
		const result = await client.callTool({
			name: "products_list",
			arguments: { company_id: "biz_someoneElse" },
		});
		expect(result.isError).toBe(true);
		expect(parseResult(result)).toMatchObject({
			error: { code: "account_mismatch" },
		});
	});

	it("names the targeted business when approving on an unbound connection", async () => {
		const client = await connect({
			principal: principalFixture({ accountId: null }),
		});
		const prepared = parseResult(
			await client.callTool({
				name: "cards_create",
				arguments: { account_id: "biz_someBusiness", name: "Test card" },
			}),
		);
		expect(prepared.prepared).toBe(true);
		expect(prepared.executed).toBe(false);
		// The approving human must still see which business this touches.
		expect(prepared.account_id).toBe("biz_someBusiness");
	});

	it("allows any business on an unbound connection", async () => {
		const client = await connect({
			principal: principalFixture({ accountId: null }),
		});
		for (const account of ["biz_first", "biz_second"]) {
			const result = await client.callTool({
				name: "products_list",
				arguments: { account_id: account },
			});
			expect(result.isError).toBeFalsy();
		}
	});

	it("reports safe connection diagnostics without credentials", async () => {
		const client = await connect();
		const status = parseResult(
			await client.callTool({ name: "connection_status", arguments: {} }),
		);
		expect(status).toMatchObject({
			account_id: "biz_boundAccount",
			principal_type: "business",
			permission_profile: "admin",
			api_version_date: registry.meta.apiVersionDate,
			openapi_sha256: registry.meta.openapiSha256,
		});
		expect(JSON.stringify(status)).not.toContain("apik_");
		expect(status.tool_count).toBe(
			registry.operations.filter((op) => op.principals.includes("business"))
				.length,
		);
	});
});

describe("confirmation modes and policy hooks", () => {
	async function connectWith(
		options: Parameters<typeof createWhopMcpServer>[0],
	) {
		const { server } = createWhopMcpServer(options);
		const client = new Client({ name: "test-client", version: "1.0.0" });
		const [clientTransport, serverTransport] =
			InMemoryTransport.createLinkedPair();
		await Promise.all([
			server.connect(serverTransport),
			client.connect(clientTransport),
		]);
		return client;
	}

	it("executes confirmation-required tools directly in host-approval mode", async () => {
		const { fetch, requests } = fakeFetch(() => ({ body: { id: "pay_1" } }));
		const client = await connectWith({
			registry,
			credentialAdapter: staticCredential(),
			principal: principalFixture(),
			confirmationMode: "host-approval",
			fetch,
			baseUrl: "https://api.whop.test/api/v1",
		});
		const result = parseResult(
			await client.callTool({
				name: "payments_refund",
				arguments: { id: "pay_123456" },
			}),
		);
		expect(result).toEqual({ id: "pay_1" });
		expect(requests.length).toBe(1);
		expect(requests[0].headers["idempotency-key"]).toBeTruthy();
	});

	it("omits the MCP confirmation token but keeps idempotency_key in host-approval mode", async () => {
		const client = await connectWith({
			registry,
			credentialAdapter: staticCredential(),
			principal: principalFixture(),
			confirmationMode: "host-approval",
			fetch: fakeFetch().fetch,
		});
		const { tools } = await client.listTools();
		const refund = tools.find((t) => t.name === "payments_refund")!;
		const properties = Object.keys(
			(refund.inputSchema as { properties: Record<string, unknown> })
				.properties,
		);
		expect(properties).not.toContain("mcp_confirmation_token");
		// Still offered: a retried direct execution must reuse the same key or
		// the upstream 24h replay cannot prevent double execution.
		expect(properties).toContain("idempotency_key");
	});

	it("forwards a caller-supplied idempotency key on direct executions", async () => {
		const { fetch, requests } = fakeFetch(() => ({ body: { id: "pay_1" } }));
		const client = await connectWith({
			registry,
			credentialAdapter: staticCredential(),
			principal: principalFixture(),
			confirmationMode: "host-approval",
			fetch,
			baseUrl: "https://api.whop.test/api/v1",
		});
		await client.callTool({
			name: "payments_refund",
			arguments: { id: "pay_123456", idempotency_key: "retry-key-1" },
		});
		expect(requests[0].headers["idempotency-key"]).toBe("retry-key-1");
	});

	it("requires a confirmation secret in enforce mode", () => {
		expect(() =>
			createWhopMcpServer({
				registry,
				credentialAdapter: staticCredential(),
				principal: principalFixture(),
			}),
		).toThrow(/confirmationSecret/);
	});

	it("restricts the surface with nativeOnly", async () => {
		const client = await connectWith({
			registry,
			credentialAdapter: staticCredential(),
			principal: principalFixture(),
			confirmationSecret: SECRET,
			nativeOnly: true,
			fetch: fakeFetch().fetch,
		});
		const { tools } = await client.listTools();
		const nativeBusinessOps = registry.operations.filter(
			(op) => op.surface === "native" && op.principals.includes("business"),
		);
		expect(tools.length).toBe(nativeBusinessOps.length + 1);
		expect(tools.map((t) => t.name)).not.toContain("payments_refund");
	});

	it("lets beforeCall block an execution", async () => {
		const { fetch, requests } = fakeFetch();
		const client = await connectWith({
			registry,
			credentialAdapter: staticCredential(),
			principal: principalFixture(),
			confirmationMode: "host-approval",
			fetch,
			beforeCall: async (operation) => {
				if (operation.safety.financial) {
					throw new WhopMcpError(
						"confirmation_required",
						"Financial operations are blocked by policy.",
					);
				}
			},
		});
		const blocked = await client.callTool({
			name: "payments_refund",
			arguments: { id: "pay_123456" },
		});
		expect(blocked.isError).toBe(true);
		expect(parseResult(blocked)).toMatchObject({
			error: { code: "confirmation_required" },
		});
		expect(requests.length).toBe(0);

		const allowed = await client.callTool({
			name: "products_list",
			arguments: {},
		});
		expect(allowed.isError).toBeFalsy();
		expect(requests.length).toBe(1);
	});
});
