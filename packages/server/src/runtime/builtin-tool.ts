import type { Tool } from "@modelcontextprotocol/server";
import type { JsonSchema } from "../registry/types.ts";
import { WhopMcpError } from "./errors.ts";
import type { McpRequestContext } from "./mcp-context.ts";
import { validateAgainstSchema } from "./validate.ts";

export type ToolDefinition = Omit<Tool, "inputSchema"> & {
	inputSchema: JsonSchema & { type: "object" };
};

export interface BuiltinTool {
	definition: ToolDefinition;
	instruction?: string;
	asksForIntent?: boolean;
	call(
		args: Record<string, unknown>,
		signal?: AbortSignal,
		mcpRequestContext?: McpRequestContext,
	): Promise<string>;
}

export function validateToolArgs(
	tool: ToolDefinition,
	args: Record<string, unknown>,
): void {
	const errors = validateAgainstSchema(args, tool.inputSchema);
	for (const [key, value] of Object.entries(args)) {
		if (typeof value !== "string") continue;
		const { minLength, maxLength, pattern } =
			tool.inputSchema.properties?.[key] ?? {};
		if (
			(typeof minLength === "number" && value.length < minLength) ||
			(typeof maxLength === "number" && value.length > maxLength) ||
			(typeof pattern === "string" && !new RegExp(pattern).test(value))
		) {
			errors.push(`${key} does not match its declared length or pattern`);
		}
	}
	if (errors.length) {
		throw new WhopMcpError(
			"invalid_input",
			`Invalid ${tool.name} input: ${errors.slice(0, 5).join("; ")}`,
		);
	}
}
