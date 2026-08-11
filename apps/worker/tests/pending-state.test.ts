import { describe, expect, it } from "vitest";
import { openJson, sealJson } from "../src/pending-state.ts";

const SECRET = "pending-state-test-secret";

describe("pending state sealing", () => {
	it("round-trips pending state and never stores the verifier readable", async () => {
		const value = {
			authRequest: { clientId: "client_1", redirectUri: "http://localhost/cb" },
			codeVerifier: "cv_secret_1",
			profile: "admin",
		};
		const sealed = await sealJson(SECRET, value, "state_1");
		expect(sealed).not.toContain("cv_secret_1");
		expect(sealed).not.toContain("client_1");
		await expect(openJson(SECRET, sealed, "state_1")).resolves.toEqual(value);
	});

	it("returns null for tampered, transplanted, or foreign-key payloads", async () => {
		const sealed = await sealJson(SECRET, { ok: true }, "state_1");
		await expect(
			openJson("other-secret-entirely", sealed, "state_1"),
		).resolves.toBeNull();
		await expect(openJson(SECRET, sealed, "state_2")).resolves.toBeNull();
		const [iv, ct] = sealed.split(".");
		const flipped = `${iv}.${ct.slice(0, -4)}AAAA`;
		await expect(openJson(SECRET, flipped, "state_1")).resolves.toBeNull();
		await expect(openJson(SECRET, "garbage", "state_1")).resolves.toBeNull();
	});

	it("refuses a key shorter than 16 characters", async () => {
		await expect(sealJson("short", { ok: true }, "s")).rejects.toThrow(
			"at least 16 characters",
		);
	});
});
