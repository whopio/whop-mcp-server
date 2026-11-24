import type { OperationDef } from "../registry/types.ts";
import type { ToolNaming } from "./tool-names.ts";
import {
	CALL_READ_OPERATION_TOOL,
	CALL_WRITE_OPERATION_TOOL,
	DESCRIBE_OPERATION_TOOL,
	SEARCH_OPERATIONS_TOOL,
} from "./operation-tools.ts";

type CallVia =
	| typeof CALL_READ_OPERATION_TOOL
	| typeof CALL_WRITE_OPERATION_TOOL;

/** Which tools a connection can call, and how. */
export interface ToolReach {
	listed: ReadonlySet<string>;
	writes: ReadonlySet<string>;
	/** Operations that aren't listed but run through an operation tool. */
	bySearch: ReadonlyMap<string, CallVia>;
	naming: ToolNaming;
}

export function toolReach(
	operations: readonly OperationDef[],
	listedOperations: readonly OperationDef[],
	builtinNames: Iterable<string>,
	naming: ToolNaming,
): ToolReach {
	const builtins = new Set(builtinNames);
	const listed = new Set([
		...listedOperations.map((op) => op.toolName),
		...builtins,
	]);
	const bySearch = new Map<string, CallVia>();
	const writes = new Set(
		operations
			.filter((op) => !op.annotations.readOnlyHint)
			.map((op) => op.toolName),
	);
	for (const op of operations) {
		if (listed.has(op.toolName)) continue;
		const via = op.annotations.readOnlyHint
			? CALL_READ_OPERATION_TOOL
			: CALL_WRITE_OPERATION_TOOL;
		if (builtins.has(via)) bySearch.set(op.toolName, via);
	}
	return { listed, writes, bySearch, naming };
}

export function canReach(reach: ToolReach, tool: string): boolean {
	return reach.listed.has(tool) || reach.bySearch.has(tool);
}

/**
 * Names tools in guide text: a listed tool by its name, one that isn't listed
 * with the operation tool that runs it, and one the connection can't call
 * (its scopes were narrowed at sign-in) as unavailable.
 */
export class ToolNamer {
	private readonly vias = new Set<CallVia>();

	constructor(
		private readonly reach: ToolReach,
		private readonly markdown: boolean,
	) {}

	name = (tool: string): string => {
		const code = (text: string) => (this.markdown ? `\`${text}\`` : text);
		const shown = code(this.reach.naming.name(tool));
		if (this.reach.listed.has(tool)) return shown;
		const via = this.reach.bySearch.get(tool);
		if (!via) return `${shown} (not available on this connection)`;
		this.vias.add(via);
		return `${shown} (through ${code(via)})`;
	};

	/** Appends how to run the unlisted tools the text named, if it named any. */
	withHint(text: string): string {
		if (!this.vias.size) return text;
		const shown = [...this.vias].map((via) => `"through ${via}"`).join(" or ");
		return `${text}\n\nA tool shown ${shown} isn't in the tool list. Call ${DESCRIBE_OPERATION_TOOL} with its name to see its inputs, then run it with the tool named, passing the name and its arguments. For anything else, ${SEARCH_OPERATIONS_TOOL} finds operations from a description in plain words.`;
	}
}
