import type { OperationDef } from "../registry/types.ts";
import type { CalledAs } from "../safety/audit.ts";

/**
 * How a route names operations to the client. The server works in registry
 * names throughout (flows, account binding, audits, attribution); a route
 * that lists verb names converts where it writes a name for the client, and
 * still accepts both names in a call.
 */
export interface ToolNaming {
	/** The name the route lists a tool under, given its registry name. */
	name(toolName: string): string;
	/**
	 * Hand-written text (operation descriptions, instructions, errors), with
	 * each registry name it mentions as listed.
	 */
	inText(text: string): string;
}

export const REGISTRY_NAMING: ToolNaming = {
	name: (toolName) => toolName,
	inText: (text) => text,
};

// Built once per registry; a hosted worker builds a server per request.
const verbNamings = new WeakMap<readonly OperationDef[], ToolNaming>();

export function verbNaming(operations: readonly OperationDef[]): ToolNaming {
	const known = verbNamings.get(operations);
	if (known) return known;
	const verbs = new Map(
		operations
			.filter((op) => op.verbName !== op.toolName)
			.map((op) => [op.toolName, op.verbName]),
	);
	const alternatives = [...verbs.keys()]
		.sort((a, b) => b.length - a.length)
		.map((name) => name.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&"))
		.join("|");
	const mention = new RegExp(`(?<![\\w-])(?:${alternatives})(?![\\w-])`, "g");
	const name = (toolName: string) => verbs.get(toolName) ?? toolName;
	const naming: ToolNaming = {
		name,
		inText: (text) => (verbs.size ? text.replace(mention, name) : text),
	};
	verbNamings.set(operations, naming);
	return naming;
}

/** Every name a call may use for each operation: the listed one and the registry one. */
export function operationsByName(
	operations: readonly OperationDef[],
): Map<string, OperationDef> {
	return new Map(
		operations.flatMap((op) => [
			[op.toolName, op],
			[op.verbName, op],
		]),
	);
}

export function calledAs(operation: OperationDef, name: string): CalledAs {
	return name === operation.verbName ? "verb_name" : "registry_name";
}
