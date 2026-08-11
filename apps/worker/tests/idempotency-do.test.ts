import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
	DurableObject: class {
		ctx: unknown;
		constructor(ctx: unknown) {
			this.ctx = ctx;
		}
	},
}));

const { IdempotencyDO, durableIdempotencyStore } =
	await import("../src/idempotency-do.ts");

class StorageStub {
	record: unknown;
	alarm: number | undefined;

	async get<T>(key: string): Promise<T | undefined> {
		return key === "record" ? (this.record as T | undefined) : undefined;
	}

	async put(key: string, value: unknown): Promise<void> {
		if (key === "record") this.record = value;
	}

	async setAlarm(timestamp: number): Promise<void> {
		this.alarm = timestamp;
	}

	async delete(key: string): Promise<boolean> {
		if (key !== "record" || this.record === undefined) return false;
		this.record = undefined;
		return true;
	}

	async deleteAlarm(): Promise<void> {
		this.alarm = undefined;
	}

	async transaction<T>(callback: (storage: StorageStub) => Promise<T>) {
		return callback(this);
	}

	async deleteAll(): Promise<void> {
		this.record = undefined;
		this.alarm = undefined;
	}
}

class LegacyObjectState {
	record: unknown;
}

class LegacyObjectStub {
	#state: LegacyObjectState;
	#broken = false;

	constructor(state: LegacyObjectState) {
		this.#state = state;
	}

	async claim(): Promise<never> {
		this.#broken = true;
		throw new Error("claim is not a function");
	}

	async complete(): Promise<never> {
		this.#broken = true;
		throw new Error("complete is not a function");
	}

	async release(): Promise<never> {
		this.#broken = true;
		throw new Error("release is not a function");
	}

	async markUnknown(): Promise<never> {
		this.#broken = true;
		throw new Error("markUnknown is not a function");
	}

	#assertUsable() {
		if (this.#broken) throw new Error("broken Durable Object stub");
	}

	async get<T>(): Promise<T | null> {
		this.#assertUsable();
		return (this.#state.record as T | undefined) ?? null;
	}

	async put(record: unknown): Promise<void> {
		this.#assertUsable();
		this.#state.record = record;
	}

	async reserve<T>(record: T): Promise<T | null> {
		this.#assertUsable();
		if (this.#state.record !== undefined) return this.#state.record as T;
		this.#state.record = record;
		return null;
	}

	async delete(): Promise<void> {
		this.#assertUsable();
		this.#state.record = undefined;
	}
}

function createLegacyNamespace() {
	const states = new Map<string, LegacyObjectState>();
	return {
		idFromName: (key: string) => key,
		get: (key: string) => {
			let state = states.get(key);
			if (!state) {
				state = new LegacyObjectState();
				states.set(key, state);
			}
			return new LegacyObjectStub(state);
		},
	};
}

function createObject() {
	const storage = new StorageStub();
	const object = new IdempotencyDO({ storage } as never, {});
	return { object, storage };
}

describe("IdempotencyDO", () => {
	it("fences takeovers, completion, and release by owner", async () => {
		const { object, storage } = createObject();
		const firstClaim = {
			argsHash: "args-a",
			callerKeyHash: "caller-a",
			ownerId: "owner-a",
		};
		expect(
			await object.claim(firstClaim, { takeoverIncomplete: false }),
		).toMatchObject({ status: "acquired" });
		expect(storage.alarm).toBeTypeOf("number");

		expect(
			await object.claim(
				{ ...firstClaim, ownerId: "owner-b" },
				{ takeoverIncomplete: true },
			),
		).toMatchObject({
			status: "taken_over",
			record: { ownerId: "owner-b" },
		});
		expect(await object.release("owner-a")).toBe("stale");
		expect(
			await object.complete(
				"owner-b",
				{ id: "result-1" },
				"2026-08-03T00:00:00.000Z",
			),
		).toBe("completed");
		expect(await object.get()).toMatchObject({
			version: 2,
			state: "completed",
			result: { id: "result-1" },
		});
	});

	it("prevents rolling legacy calls from overwriting v2 records", async () => {
		const { object } = createObject();
		await object.claim(
			{
				argsHash: "args-a",
				callerKeyHash: "caller-a",
				ownerId: "owner-a",
			},
			{ takeoverIncomplete: false },
		);

		await object.put({ argsHash: "legacy", result: { id: "legacy" } });
		await object.delete();
		await object.put({
			version: 2,
			state: "completed",
			argsHash: "args-a",
			callerKeyHash: "caller-a",
			ownerId: "owner-b",
			result: { id: "stale" },
			completedAt: "2026-08-03T00:00:00.000Z",
		});
		await object.delete("owner-b");
		expect(await object.get()).toMatchObject({
			version: 2,
			state: "reserved",
			argsHash: "args-a",
		});
	});

	it("refreshes the retention window when an outcome becomes unknown", async () => {
		const now = vi
			.spyOn(Date, "now")
			.mockReturnValueOnce(1_000)
			.mockReturnValueOnce(2_000);
		try {
			const { object, storage } = createObject();
			await object.claim(
				{
					argsHash: "args-a",
					callerKeyHash: "caller-a",
					ownerId: "owner-a",
				},
				{ takeoverIncomplete: false },
			);
			const reservedAlarm = storage.alarm;

			expect(
				await object.markUnknown("owner-a", "2026-08-03T00:00:00.000Z"),
			).toBe("marked_unknown");
			expect(storage.alarm).toBeGreaterThan(reservedAlarm ?? 0);
		} finally {
			now.mockRestore();
		}
	});

	it("uses legacy RPCs safely while old objects finish rolling out", async () => {
		const store = durableIdempotencyStore(createLegacyNamespace() as never);
		const input = {
			argsHash: "args-a",
			callerKeyHash: "caller-a",
			ownerId: "owner-a",
		};

		expect(
			await store.claim("completed", input, { takeoverIncomplete: false }),
		).toMatchObject({ status: "acquired" });
		expect(
			await store.complete(
				"completed",
				"owner-a",
				{ id: "result-1" },
				"2026-08-03T00:00:00.000Z",
			),
		).toBe("completed");
		expect(await store.get("completed")).toMatchObject({
			version: 2,
			state: "completed",
			result: { id: "result-1" },
		});

		expect(
			await store.claim("unknown", input, { takeoverIncomplete: false }),
		).toMatchObject({ status: "acquired" });
		expect(
			await store.markUnknown("unknown", "owner-a", "2026-08-03T00:00:00.000Z"),
		).toBe("marked_unknown");
		expect(await store.get("unknown")).toMatchObject({
			version: 2,
			state: "outcome_unknown",
		});

		expect(
			await store.claim("released", input, { takeoverIncomplete: false }),
		).toMatchObject({ status: "acquired" });
		expect(await store.release("released", "owner-a")).toBe("released");
		expect(await store.get("released")).toBeNull();
	});

	it("reconciles replay-safe retries without transferring the legacy owner", async () => {
		const store = durableIdempotencyStore(createLegacyNamespace() as never);
		const firstInput = {
			argsHash: "args-a",
			callerKeyHash: "caller-a",
			ownerId: "owner-a",
		};
		const retryInput = { ...firstInput, ownerId: "owner-b" };

		expect(
			await store.claim("takeover", firstInput, {
				takeoverIncomplete: true,
			}),
		).toMatchObject({ status: "acquired" });
		expect(
			await store.claim("takeover", retryInput, {
				takeoverIncomplete: true,
			}),
		).toMatchObject({
			status: "taken_over",
			record: { ownerId: "owner-b" },
		});
		expect(await store.get("takeover")).toMatchObject({
			state: "reserved",
			ownerId: "owner-a",
		});

		expect(
			await store.complete(
				"takeover",
				"owner-b",
				{ id: "replayed-result" },
				"2026-08-03T00:00:00.000Z",
			),
		).toBe("stale");
		expect(
			await store.markUnknown(
				"takeover",
				"owner-b",
				"2026-08-03T00:00:00.000Z",
			),
		).toBe("stale");
		expect(await store.release("takeover", "owner-b")).toBe("stale");
		expect(await store.get("takeover")).toMatchObject({
			state: "reserved",
			ownerId: "owner-a",
		});

		expect(
			await store.claim("takeover", retryInput, {
				takeoverIncomplete: false,
			}),
		).toMatchObject({
			status: "existing",
			record: { ownerId: "owner-a" },
		});

		expect(
			await store.complete(
				"takeover",
				"owner-a",
				{ id: "original-result" },
				"2026-08-03T00:00:00.000Z",
			),
		).toBe("completed");
		expect(await store.release("takeover", "owner-b")).toBe("stale");
		expect(await store.get("takeover")).toMatchObject({
			state: "completed",
			result: { id: "original-result" },
		});
	});

	it.each([
		Object.assign(new Error("claim is not a function"), { overloaded: true }),
		Object.assign(new Error("claim is not a function"), { retryable: true }),
		new Error("Durable Object storage is temporarily unavailable"),
	])("does not downgrade infrastructure RPC failures", async (rpcError) => {
		let legacyReserveCalls = 0;
		const namespace = {
			idFromName: (key: string) => key,
			get: () => ({
				claim: async () => {
					throw rpcError;
				},
				reserve: async () => {
					legacyReserveCalls += 1;
					return null;
				},
			}),
		};
		const store = durableIdempotencyStore(namespace as never);

		await expect(
			store.claim(
				"rpc-error",
				{
					argsHash: "args-a",
					callerKeyHash: "caller-a",
					ownerId: "owner-a",
				},
				{ takeoverIncomplete: false },
			),
		).rejects.toBe(rpcError);
		expect(legacyReserveCalls).toBe(0);
	});
});
