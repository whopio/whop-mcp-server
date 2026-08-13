import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveRegistryInputPaths } from "../scripts/input-paths.ts";

const temporaryRoots: string[] = [];

function temporaryPackageRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "mcp-input-paths-"));
	temporaryRoots.push(root);
	return root;
}

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("registry input paths", () => {
	it("uses package-local inputs when both are present", () => {
		const packageRoot = temporaryPackageRoot();
		const inputsRoot = join(packageRoot, "inputs");
		mkdirSync(inputsRoot);
		writeFileSync(join(inputsRoot, "openapi.json"), "{}");
		writeFileSync(join(inputsRoot, "scope-definitions.json"), "{}");

		expect(resolveRegistryInputPaths(packageRoot)).toEqual({
			openapiPath: join(inputsRoot, "openapi.json"),
			scopeDefinitionsPath: join(inputsRoot, "scope-definitions.json"),
		});
	});

	it("falls back to monorepo inputs when package-local inputs are absent", () => {
		const packageRoot = temporaryPackageRoot();
		const monorepoRoot = join(packageRoot, "..", "..", "..", "..");

		expect(resolveRegistryInputPaths(packageRoot)).toEqual({
			openapiPath: join(monorepoRoot, "backend", "public", "openapi.json"),
			scopeDefinitionsPath: join(
				monorepoRoot,
				"backend",
				"lib",
				"permissions",
				"internal_scope_definitions.json",
			),
		});
	});

	it("rejects an incomplete package-local input set", () => {
		const packageRoot = temporaryPackageRoot();
		const inputsRoot = join(packageRoot, "inputs");
		mkdirSync(inputsRoot);
		writeFileSync(join(inputsRoot, "openapi.json"), "{}");

		expect(() => resolveRegistryInputPaths(packageRoot)).toThrow(
			"Package-local registry inputs are incomplete.",
		);
	});
});
