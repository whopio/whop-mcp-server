export const MCP_CONTEXT_HEADER = "X-Whop-MCP-Context";
export const MAX_MCP_CONTEXT_HEADER_CHARS = 7_000;

const MCP_CONTEXT_VERSION = 1;
const MAX_INTENT_UTF8_BYTES = 4_096;
const encoder = new TextEncoder();

export interface McpRequestContext {
	intent: string;
	intentId: string;
	toolName: string;
	toolCallId: string;
}

export function encodeMcpRequestContext(context: McpRequestContext): string {
	const capturedCharacters: string[] = [];
	let intentCharCount = 0;
	let capturedBytes = 0;
	let capturing = true;
	for (const character of context.intent) {
		intentCharCount += 1;
		const characterBytes = encoder.encode(character).byteLength;
		if (capturing && capturedBytes + characterBytes <= MAX_INTENT_UTF8_BYTES) {
			capturedCharacters.push(character);
			capturedBytes += characterBytes;
		} else {
			capturing = false;
		}
	}

	let low = 0;
	let high = capturedCharacters.length;
	let encoded = encodePayload(context, "", intentCharCount);
	while (low <= high) {
		const midpoint = Math.floor((low + high) / 2);
		const candidate = encodePayload(
			context,
			capturedCharacters.slice(0, midpoint).join(""),
			intentCharCount,
		);
		if (candidate.length <= MAX_MCP_CONTEXT_HEADER_CHARS) {
			encoded = candidate;
			low = midpoint + 1;
		} else {
			high = midpoint - 1;
		}
	}
	return encoded;
}

function encodePayload(
	context: McpRequestContext,
	intent: string,
	intentCharCount: number,
): string {
	const capturedCharCount = Array.from(intent).length;
	const bytes = encoder.encode(
		JSON.stringify({
			version: MCP_CONTEXT_VERSION,
			intent,
			intent_id: context.intentId,
			intent_char_count: intentCharCount,
			intent_truncated: capturedCharCount < intentCharCount,
			tool_name: context.toolName,
			tool_call_id: context.toolCallId,
		}),
	);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary)
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}
