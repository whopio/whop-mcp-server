import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { PrincipalContext } from "../policy/types.ts";
import type { JsonSchema } from "../registry/types.ts";
import { redactText, WhopMcpError } from "./errors.ts";
import { validateAgainstSchema } from "./validate.ts";

export interface FeedbackSubmission {
	id: string;
	createdAt: string;
	kind: "report_feedback" | "ask_question";
	userId?: string;
	accountId: string | null;
	clientName?: string;
	pluginSource?: string;
	fields: Record<string, string>;
}

export interface FeedbackSink {
	record(submission: FeedbackSubmission): Promise<string>;
}

const commonProperties = {
	content: {
		type: "string",
		minLength: 1,
		maxLength: 12000,
		pattern: "\\S",
		description:
			"The observation or unanswered question, with enough context for Whop to understand it. Remove secrets and personal or payment data before submitting.",
	},
	intention: {
		type: "string",
		minLength: 1,
		maxLength: 2000,
		pattern: "\\S",
		description: "What you were trying to accomplish when this came up.",
	},
	tool: {
		type: "string",
		minLength: 1,
		maxLength: 200,
		pattern: "\\S",
		description:
			"The affected MCP tool's exact name, if a single tool is involved.",
	},
	modelType: {
		type: "string",
		minLength: 1,
		maxLength: 200,
		pattern: "\\S",
		description: "Your model and host product, if known. Omit when unknown.",
	},
};

const annotations = {
	readOnlyHint: false,
	destructiveHint: false,
	idempotentHint: false,
	openWorldHint: true,
};

export const FEEDBACK_TOOLS: (Tool & {
	inputSchema: JsonSchema & Tool["inputSchema"];
})[] = [
	{
		name: "report_feedback",
		description:
			"Report a concrete problem or friction with Whop or these tools for internal review: an incorrect result, confusing error, documentation gap, or unexpected API behavior. Describe what happened and what you expected; include sanitized request/response details when useful. Returns a submission receipt only; no follow-up will reach this session. Submit only real observations, one per call. Never include credentials, secrets, personal data, or payment details.",
		inputSchema: {
			type: "object",
			properties: {
				...commonProperties,
				severity: {
					type: "string",
					enum: ["blocked", "degraded", "cosmetic"],
					description:
						"Impact on your task: blocked means you could not complete it, degraded means you needed a slower or awkward path, cosmetic means it worked but was confusing.",
				},
				workaround: {
					type: "string",
					minLength: 1,
					maxLength: 4000,
					pattern: "\\S",
					description:
						"What worked instead, if anything. Omit if no workaround was found.",
				},
			},
			required: ["content"],
			additionalProperties: false,
		},
		annotations,
	},
	{
		name: "ask_question",
		description:
			"Record a question about Whop you could not answer using the available tools and documentation. This collects gaps for Whop's internal review; it is not a live support or question-answering service. Returns a submission receipt only. No answer will come back now or later in this session: do not wait, poll, or repeat the question expecting an answer. Continue using available documentation and your best judgment. Submit only real unanswered questions. Never include credentials, secrets, personal data, or payment details.",
		inputSchema: {
			type: "object",
			properties: commonProperties,
			required: ["content"],
			additionalProperties: false,
		},
		annotations,
	},
];

export async function submitFeedback(
	tool: Tool,
	args: Record<string, unknown>,
	principal: PrincipalContext,
	sink: FeedbackSink,
	attribution: { clientName?: string; pluginSource?: string },
) {
	const schema = tool.inputSchema as JsonSchema;
	const errors = validateAgainstSchema(args, schema);
	for (const [key, value] of Object.entries(args)) {
		if (typeof value !== "string") continue;
		const maxLength = schema.properties?.[key]?.maxLength;
		if (
			!value.trim() ||
			(typeof maxLength === "number" && value.length > maxLength)
		) {
			errors.push(
				`${key} must be nonblank and within its declared length limit`,
			);
		}
	}
	if (errors.length) {
		throw new WhopMcpError(
			"invalid_input",
			`Invalid ${tool.name} input: ${errors.slice(0, 5).join("; ")}`,
		);
	}
	const submission: FeedbackSubmission = {
		id: crypto.randomUUID(),
		createdAt: new Date().toISOString(),
		kind: tool.name as FeedbackSubmission["kind"],
		userId: principal.userId,
		accountId: principal.accountId,
		...attribution,
		fields: Object.fromEntries(
			Object.entries(args).map(([key, value]) => [
				key,
				redactText(value as string),
			]),
		),
	};
	const submissionId = await sink.record(submission);
	return {
		submission_id: submissionId,
		status: "submitted",
		message:
			tool.name === "ask_question"
				? "Question accepted for Whop's internal review. No answer will be returned in this session; continue with available information."
				: "Feedback accepted for Whop's internal review. No follow-up will be returned in this session.",
	};
}
