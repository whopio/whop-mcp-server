import { describe, expect, it } from "vitest";
import { validateAgainstSchema } from "../src/runtime/validate.ts";

describe("validateAgainstSchema", () => {
	it("checks primitive types", () => {
		expect(validateAgainstSchema("x", { type: "string" })).toEqual([]);
		expect(validateAgainstSchema(1, { type: "string" })).toHaveLength(1);
		expect(validateAgainstSchema(1, { type: "integer" })).toEqual([]);
		expect(validateAgainstSchema(1.5, { type: "integer" })).toHaveLength(1);
		expect(validateAgainstSchema(1.5, { type: "number" })).toEqual([]);
		expect(
			validateAgainstSchema(null, { type: "string", nullable: true }),
		).toEqual([]);
	});

	it("checks required and undeclared properties", () => {
		const schema = {
			type: "object",
			properties: { a: { type: "string" } },
			required: ["a"],
			additionalProperties: false,
		};
		expect(validateAgainstSchema({ a: "x" }, schema)).toEqual([]);
		expect(validateAgainstSchema({}, schema)).toHaveLength(1);
		expect(validateAgainstSchema({ a: "x", b: 1 }, schema)).toHaveLength(1);
	});

	it("checks enums, arrays, and unions", () => {
		expect(
			validateAgainstSchema("no", { enum: ["yes", "maybe"] }),
		).toHaveLength(1);
		expect(
			validateAgainstSchema(["a", 1], {
				type: "array",
				items: { type: "string" },
			}),
		).toHaveLength(1);
		const union: import("../src/registry/types.ts").JsonSchema = {
			oneOf: [
				{
					type: "object",
					properties: { a: { type: "string" } },
					required: ["a"],
				},
				{
					type: "object",
					properties: { b: { type: "integer" } },
					required: ["b"],
				},
			],
		};
		expect(validateAgainstSchema({ a: "x" }, union)).toEqual([]);
		expect(validateAgainstSchema({ b: 2 }, union)).toEqual([]);
		expect(validateAgainstSchema({ c: true }, union)).toHaveLength(1);
	});
});
