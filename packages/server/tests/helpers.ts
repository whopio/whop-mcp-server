import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import {
	buildRegistry,
	type GeneratorMetadata,
} from "../src/registry/generate.ts";
import type { OperationDef, RegistryManifest } from "../src/registry/types.ts";
import type {
	CredentialAdapter,
	PrincipalContext,
} from "../src/policy/types.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const packageRoot = join(__dirname, "..");
const inputsRoot = join(packageRoot, "inputs");

export function loadOpenApiRaw(): string {
	return readFileSync(join(inputsRoot, "openapi.json"), "utf8");
}

export function loadMetadata(): GeneratorMetadata {
	const load = (name: string) =>
		parseYaml(readFileSync(join(packageRoot, "metadata", name), "utf8"));
	return {
		safety: load("safety.yml"),
		exclusions: load("exclusions.yml"),
		overrides: load("operation-overrides.yml"),
		scopeDefinitions: JSON.parse(
			readFileSync(join(inputsRoot, "scope-definitions.json"), "utf8"),
		),
	};
}

export function buildRealRegistry(): RegistryManifest {
	const raw = loadOpenApiRaw();
	return buildRegistry(JSON.parse(raw), loadMetadata(), {
		openapiSha256: createHash("sha256").update(raw).digest("hex"),
	});
}

export function principalFixture(
	overrides: Partial<PrincipalContext> = {},
): PrincipalContext {
	return {
		principalType: "business",
		userId: "user_test1",
		accountId: "biz_boundAccount",
		scopes: ["*"],
		permissionProfile: "admin",
		...overrides,
	};
}

export function staticCredential(
	token = "apik_testtoken1234",
): CredentialAdapter {
	return { getCredential: async () => ({ token }) };
}

export interface RecordedRequest {
	url: string;
	method: string;
	headers: Record<string, string>;
	body: unknown;
}

export function fakeFetch(
	respond: (request: RecordedRequest) => {
		status?: number;
		body?: unknown;
		headers?: Record<string, string>;
	} = () => ({ body: { ok: true } }),
): { fetch: typeof fetch; requests: RecordedRequest[] } {
	const requests: RecordedRequest[] = [];
	const impl = (async (
		input: Parameters<typeof fetch>[0],
		init?: RequestInit,
	) => {
		const headers: Record<string, string> = {};
		for (const [key, value] of Object.entries(init?.headers ?? {})) {
			headers[key.toLowerCase()] = value as string;
		}
		const recorded: RecordedRequest = {
			url: String(input),
			method: init?.method ?? "GET",
			headers,
			body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
		};
		requests.push(recorded);
		const response = respond(recorded);
		return new Response(JSON.stringify(response.body ?? { ok: true }), {
			status: response.status ?? 200,
			headers: {
				"Content-Type": "application/json",
				"x-request-id": "req_test",
				...response.headers,
			},
		});
	}) as typeof fetch;
	return { fetch: impl, requests };
}

export function findOperation(
	registry: RegistryManifest,
	toolName: string,
): OperationDef {
	const op = registry.operations.find((o) => o.toolName === toolName);
	if (!op) throw new Error(`No operation named ${toolName} in registry`);
	return op;
}
