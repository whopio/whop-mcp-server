import { existsSync } from "node:fs";
import { expect, it } from "vitest";
import { loadMetadata, loadOpenApiRaw } from "./helpers.ts";

it.skipIf(!existsSync(new URL("../inputs/openapi.json", import.meta.url)))(
	"bundles only referenced public scope capability fields",
	() => {
		const doc = JSON.parse(loadOpenApiRaw()) as {
			paths: Record<
				string,
				Record<string, { security?: { bearerAuth?: string[] }[] }>
			>;
		};
		const referencedScopes = new Set<string>();
		for (const item of Object.values(doc.paths)) {
			for (const method of ["get", "post", "put", "patch", "delete"]) {
				for (const alternative of item[method]?.security ?? []) {
					for (const scope of alternative.bearerAuth ?? []) {
						referencedScopes.add(scope);
					}
				}
			}
		}

		const definitions = loadMetadata().scopeDefinitions;
		expect(Object.keys(definitions).sort()).toEqual(
			[...referencedScopes].sort(),
		);
		const allowedFields = new Set([
			"bot",
			"user",
			"disallow_api_authorization",
			"disallow_app_authorization",
		]);
		for (const definition of Object.values(definitions)) {
			expect(
				Object.keys(definition).filter((field) => !allowedFields.has(field)),
			).toEqual([]);
		}
	},
);
