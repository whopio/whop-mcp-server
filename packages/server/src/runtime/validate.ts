import type { JsonSchema } from "../registry/types.ts";

/**
 * Minimal JSON Schema validator covering the subset the registry generator
 * emits (type, enum, properties, required, items, additionalProperties,
 * oneOf/anyOf, nullable). Hand-rolled because Ajv compiles validators with
 * `new Function`, which Cloudflare Workers disallow.
 */
export function validateAgainstSchema(
	value: unknown,
	schema: JsonSchema,
	path = "$",
): string[] {
	const errors: string[] = [];
	validate(value, schema, path, errors);
	return errors;
}

function typeOf(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	if (typeof value === "number") {
		return Number.isInteger(value) ? "integer" : "number";
	}
	return typeof value;
}

function typeMatches(actual: string, expected: string): boolean {
	if (expected === "number") return actual === "number" || actual === "integer";
	return actual === expected;
}

function validate(
	value: unknown,
	schema: JsonSchema,
	path: string,
	errors: string[],
): void {
	if (value === null && schema.nullable) return;

	const union = schema.oneOf ?? schema.anyOf;
	if (union) {
		const attempts = union.map((variant) =>
			validateAgainstSchema(value, variant, path),
		);
		if (!attempts.some((attempt) => attempt.length === 0)) {
			errors.push(
				`${path} does not match any allowed variant (${attempts[0]?.[0] ?? "no variants"})`,
			);
		}
		return;
	}

	if (schema.allOf) {
		for (const part of schema.allOf) validate(value, part, path, errors);
		return;
	}

	if (schema.type) {
		const expected = Array.isArray(schema.type) ? schema.type : [schema.type];
		const actual = typeOf(value);
		if (!expected.some((t) => typeMatches(actual, t))) {
			errors.push(`${path} must be ${expected.join(" or ")}, got ${actual}`);
			return;
		}
	}

	if (schema.enum && !schema.enum.some((e) => e === value)) {
		errors.push(`${path} must be one of ${JSON.stringify(schema.enum)}`);
		return;
	}

	if (Array.isArray(value) && schema.items) {
		value.forEach((item, i) =>
			validate(item, schema.items as JsonSchema, `${path}[${i}]`, errors),
		);
	}

	if (
		value !== null &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		(schema.properties ||
			schema.required ||
			schema.additionalProperties !== undefined)
	) {
		const obj = value as Record<string, unknown>;
		const properties = schema.properties ?? {};

		for (const name of schema.required ?? []) {
			if (obj[name] === undefined) {
				errors.push(`${path}.${name} is required`);
			}
		}

		for (const [name, propValue] of Object.entries(obj)) {
			if (propValue === undefined) continue;
			const propSchema = properties[name];
			if (propSchema) {
				validate(propValue, propSchema, `${path}.${name}`, errors);
			} else if (schema.additionalProperties === false) {
				errors.push(`${path}.${name} is not a declared property`);
			} else if (
				schema.additionalProperties &&
				typeof schema.additionalProperties === "object"
			) {
				validate(
					propValue,
					schema.additionalProperties,
					`${path}.${name}`,
					errors,
				);
			}
		}
	}
}
