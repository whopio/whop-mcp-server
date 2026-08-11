import { describe, expect, it } from "vitest";
import { ConfirmationSigner } from "../src/safety/confirmation.ts";
import { InMemoryIdempotencyStore } from "../src/safety/idempotency.ts";
import { principalFixture } from "./helpers.ts";

const SECRET = "test-secret-key-that-is-long-enough";
const principal = principalFixture();

describe("confirmation tokens", () => {
	it("round-trips for identical tool, args, principal, and account", async () => {
		const signer = new ConfirmationSigner(SECRET);
		const args = { id: "pay_1", amount: 100 };
		const { token } = await signer.issue("payments_refund", args, principal);
		const payload = await signer.verify(
			token,
			"payments_refund",
			args,
			principal,
		);
		expect(payload.tool).toBe("payments_refund");
		expect(payload.jti).toMatch(/[0-9a-f-]{36}/);
	});

	it("issues a distinct jti per token", async () => {
		const signer = new ConfirmationSigner(SECRET);
		const args = { id: "pay_1", amount: 100 };
		const first = await signer.issue("payments_refund", args, principal);
		const second = await signer.issue("payments_refund", args, principal);
		const firstPayload = await signer.verify(
			first.token,
			"payments_refund",
			args,
			principal,
		);
		const secondPayload = await signer.verify(
			second.token,
			"payments_refund",
			args,
			principal,
		);
		expect(firstPayload.jti).not.toBe(secondPayload.jti);
	});

	it("is insensitive to argument key order", async () => {
		const signer = new ConfirmationSigner(SECRET);
		const { token } = await signer.issue(
			"payments_refund",
			{ id: "pay_1", amount: 100 },
			principal,
		);
		await expect(
			signer.verify(
				token,
				"payments_refund",
				{ amount: 100, id: "pay_1" },
				principal,
			),
		).resolves.toMatchObject({ tool: "payments_refund" });
	});

	it("rejects expired tokens", async () => {
		let now = 1_000_000;
		const signer = new ConfirmationSigner(SECRET, {
			ttlMs: 1000,
			now: () => now,
		});
		const { token } = await signer.issue("payments_refund", {}, principal);
		now += 1001;
		await expect(
			signer.verify(token, "payments_refund", {}, principal),
		).rejects.toMatchObject({ code: "confirmation_invalid" });
	});

	it("rejects modified arguments", async () => {
		const signer = new ConfirmationSigner(SECRET);
		const { token } = await signer.issue(
			"payments_refund",
			{ id: "pay_1", amount: 100 },
			principal,
		);
		await expect(
			signer.verify(
				token,
				"payments_refund",
				{ id: "pay_1", amount: 9999 },
				principal,
			),
		).rejects.toMatchObject({ code: "confirmation_invalid" });
	});

	it("rejects a different tool", async () => {
		const signer = new ConfirmationSigner(SECRET);
		const { token } = await signer.issue("payments_refund", {}, principal);
		await expect(
			signer.verify(token, "transfers_create", {}, principal),
		).rejects.toMatchObject({ code: "confirmation_invalid" });
	});

	it("rejects cross-account confirmation", async () => {
		const signer = new ConfirmationSigner(SECRET);
		const { token } = await signer.issue("payments_refund", {}, principal);
		await expect(
			signer.verify(
				token,
				"payments_refund",
				{},
				principalFixture({ accountId: "biz_other" }),
			),
		).rejects.toMatchObject({ code: "confirmation_invalid" });
	});

	it("rejects cross-principal confirmation", async () => {
		const signer = new ConfirmationSigner(SECRET);
		const { token } = await signer.issue("payments_refund", {}, principal);
		await expect(
			signer.verify(
				token,
				"payments_refund",
				{},
				principalFixture({ userId: "user_other" }),
			),
		).rejects.toMatchObject({ code: "confirmation_invalid" });
	});

	it("rejects tampered and malformed tokens", async () => {
		const signer = new ConfirmationSigner(SECRET);
		const { token } = await signer.issue("payments_refund", {}, principal);
		const [body, sig] = token.split(".");
		for (const bad of [
			"garbage",
			`${body}.`,
			`${body}x.${sig}`,
			`${body}.${sig}x`,
		]) {
			await expect(
				signer.verify(bad, "payments_refund", {}, principal),
			).rejects.toMatchObject({ code: "confirmation_invalid" });
		}
	});

	it("rejects tokens signed with a different secret", async () => {
		const signer = new ConfirmationSigner(SECRET);
		const other = new ConfirmationSigner("another-secret-thats-long-enough");
		const { token } = await other.issue("payments_refund", {}, principal);
		await expect(
			signer.verify(token, "payments_refund", {}, principal),
		).rejects.toMatchObject({ code: "confirmation_invalid" });
	});
});

describe("idempotency store", () => {
	it("fences claims, completions, and releases by owner", async () => {
		const store = new InMemoryIdempotencyStore();
		const firstClaim = {
			argsHash: "hashA",
			callerKeyHash: "callerA",
			ownerId: "ownerA",
		};
		const acquired = await store.claim("biz:tool:key1", firstClaim, {
			takeoverIncomplete: false,
		});
		expect(acquired.status).toBe("acquired");

		const mismatch = await store.claim(
			"biz:tool:key1",
			{ ...firstClaim, argsHash: "hashB", ownerId: "ownerB" },
			{ takeoverIncomplete: true },
		);
		expect(mismatch.status).toBe("existing");
		expect(mismatch.record.argsHash).toBe("hashA");

		const takeover = await store.claim(
			"biz:tool:key1",
			{ ...firstClaim, ownerId: "ownerB" },
			{ takeoverIncomplete: true },
		);
		expect(takeover.status).toBe("taken_over");
		expect(await store.release("biz:tool:key1", "ownerA")).toBe("stale");
		expect(
			await store.complete(
				"biz:tool:key1",
				"ownerB",
				{ id: 1 },
				"2026-08-03T00:00:00.000Z",
			),
		).toBe("completed");

		const replay = await store.claim(
			"biz:tool:key1",
			{ ...firstClaim, ownerId: "ownerC" },
			{ takeoverIncomplete: true },
		);
		expect(replay.status).toBe("existing");
		expect(replay.record).toMatchObject({
			state: "completed",
			result: { id: 1 },
		});
		expect(await store.release("biz:tool:key1", "ownerB")).toBe("stale");

		await store.claim(
			"biz:tool:key2",
			{ ...firstClaim, ownerId: "ownerC" },
			{ takeoverIncomplete: false },
		);
		await store.complete(
			"biz:tool:key2",
			"ownerC",
			undefined,
			"2026-08-03T00:00:00.000Z",
		);
		expect(await store.get("biz:tool:key2")).toMatchObject({
			state: "completed",
		});
		expect(Object.hasOwn((await store.get("biz:tool:key2"))!, "result")).toBe(
			true,
		);
	});
});
