import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
	encodeMcpRequestContext,
	MAX_MCP_CONTEXT_HEADER_CHARS,
} from "../src/runtime/mcp-context.ts";

const CONTEXT = {
	intentId: "123e4567-e89b-42d3-a456-426614174000",
	toolName: "products_list",
	toolCallId: "223e4567-e89b-42d3-a456-426614174000",
};
const CANONICAL_CONTEXT =
	"eyJ2ZXJzaW9uIjoxLCJpbnRlbnQiOiJTaG93IG1lIHRvZGF5J3Mgc2FsZXMg8J-TiFxuQWNyb3NzIGV2ZXJ5IGJ1c2luZXNzIiwiaW50ZW50X2lkIjoiMTIzZTQ1NjctZTg5Yi00MmQzLWE0NTYtNDI2NjE0MTc0MDAwIiwiaW50ZW50X2NoYXJfY291bnQiOjQ1LCJpbnRlbnRfdHJ1bmNhdGVkIjpmYWxzZSwidG9vbF9uYW1lIjoicHJvZHVjdHNfbGlzdCIsInRvb2xfY2FsbF9pZCI6IjIyM2U0NTY3LWU4OWItNDJkMy1hNDU2LTQyNjYxNDE3NDAwMCJ9";

function decode(value: string): Record<string, unknown> {
	return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
}

describe("MCP request context", () => {
	it("round-trips Unicode intent metadata", () => {
		const encoded = encodeMcpRequestContext({
			...CONTEXT,
			intent: "Show me today's sales 📈\nAcross every business",
		});
		expect(encoded).toBe(CANONICAL_CONTEXT);
		expect(decode(encoded)).toEqual({
			version: 1,
			intent: "Show me today's sales 📈\nAcross every business",
			intent_id: CONTEXT.intentId,
			intent_char_count: 45,
			intent_truncated: false,
			tool_name: CONTEXT.toolName,
			tool_call_id: CONTEXT.toolCallId,
		});
	});

	it("truncates on a UTF-8 boundary and retains the original character count", () => {
		const intent = "📈".repeat(2_000);
		const encoded = encodeMcpRequestContext({ ...CONTEXT, intent });
		const decoded = decode(encoded);
		expect(
			Buffer.byteLength(decoded.intent as string, "utf8"),
		).toBeLessThanOrEqual(4_096);
		expect((decoded.intent as string).endsWith("📈")).toBe(true);
		expect(decoded.intent_char_count).toBe(2_000);
		expect(decoded.intent_truncated).toBe(true);
	});

	it("bounds the final header when JSON escaping expands the intent", () => {
		const encoded = encodeMcpRequestContext({
			...CONTEXT,
			intent: "\n".repeat(5_000),
		});
		const decoded = decode(encoded);
		expect(encoded.length).toBeLessThanOrEqual(MAX_MCP_CONTEXT_HEADER_CHARS);
		expect(decoded.intent_char_count).toBe(5_000);
		expect(decoded.intent_truncated).toBe(true);
	});
});
