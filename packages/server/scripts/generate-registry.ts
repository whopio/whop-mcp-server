import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import {
	buildRegistry,
	GENERATOR_VERSION,
	type GeneratorMetadata,
} from "../src/registry/generate.ts";
import { resolveRegistryInputPaths } from "./input-paths.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(__dirname, "..");
const { openapiPath, scopeDefinitionsPath } =
	resolveRegistryInputPaths(packageRoot);
const manifestPath = join(packageRoot, "generated", "manifest.json");

function loadYaml(name: string): unknown {
	return parseYaml(readFileSync(join(packageRoot, "metadata", name), "utf8"));
}

const openapiRaw = readFileSync(openapiPath, "utf8");
const metadata: GeneratorMetadata = {
	safety: loadYaml("safety.yml") as GeneratorMetadata["safety"],
	exclusions: loadYaml("exclusions.yml") as GeneratorMetadata["exclusions"],
	overrides: loadYaml(
		"operation-overrides.yml",
	) as GeneratorMetadata["overrides"],
	scopeDefinitions: JSON.parse(
		readFileSync(scopeDefinitionsPath, "utf8"),
	) as GeneratorMetadata["scopeDefinitions"],
};

const manifest = buildRegistry(JSON.parse(openapiRaw), metadata, {
	openapiSha256: createHash("sha256").update(openapiRaw).digest("hex"),
});

if (process.argv.includes("--summary")) {
	const flags = (op: (typeof manifest.operations)[number]): string => {
		const out: string[] = [op.safety.classification];
		if (op.safety.financial) out.push("financial");
		if (op.safety.credential) out.push("credential");
		if (op.safety.confirmationRequired) out.push("confirm");
		return out.join(",");
	};
	for (const op of manifest.operations) {
		console.log(
			`${op.toolName}  ${op.method.toUpperCase()} ${op.path}  [${op.surface}]  ${flags(op)}`,
		);
	}
	for (const entry of manifest.exclusions) {
		console.log(`excluded: ${entry.operation} — ${entry.reason}`);
	}
	for (const entry of manifest.meta.pendingReview) {
		console.log(
			`PENDING REVIEW (not exposed): ${entry.operation}  [${entry.surface}]  tag=${entry.tag}`,
		);
	}
	console.log(
		`\n${manifest.meta.operationCount} operations (${manifest.meta.nativeOperationCount} native), ` +
			`${manifest.meta.exclusionCount} exclusions, ${manifest.meta.pendingReview.length} pending review, ` +
			`API version ${manifest.meta.apiVersionDate}, generator ${GENERATOR_VERSION}.`,
	);
} else {
	mkdirSync(dirname(manifestPath), { recursive: true });
	writeFileSync(manifestPath, `${JSON.stringify(manifest, null, "\t")}\n`);
	console.error(
		`Wrote generated/manifest.json: ${manifest.meta.operationCount} operations ` +
			`(${manifest.meta.nativeOperationCount} native), ${manifest.meta.exclusionCount} exclusions, ` +
			`${manifest.meta.pendingReview.length} pending review, API version ${manifest.meta.apiVersionDate}.`,
	);
}
