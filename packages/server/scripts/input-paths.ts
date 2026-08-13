import { existsSync } from "node:fs";
import { join } from "node:path";

export interface RegistryInputPaths {
	openapiPath: string;
	scopeDefinitionsPath: string;
}

export function resolveRegistryInputPaths(
	packageRoot: string,
): RegistryInputPaths {
	const inputsRoot = join(packageRoot, "inputs");
	const packageInputs = {
		openapiPath: join(inputsRoot, "openapi.json"),
		scopeDefinitionsPath: join(inputsRoot, "scope-definitions.json"),
	};
	const packageInputPresence = Object.values(packageInputs).map(existsSync);
	if (packageInputPresence.every(Boolean)) return packageInputs;
	if (packageInputPresence.some(Boolean)) {
		throw new Error("Package-local registry inputs are incomplete.");
	}

	const monorepoRoot = join(packageRoot, "..", "..", "..", "..");
	return {
		openapiPath: join(monorepoRoot, "backend", "public", "openapi.json"),
		scopeDefinitionsPath: join(
			monorepoRoot,
			"backend",
			"lib",
			"permissions",
			"internal_scope_definitions.json",
		),
	};
}
