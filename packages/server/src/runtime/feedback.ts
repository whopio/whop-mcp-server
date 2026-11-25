import type { PrincipalContext } from "../policy/types.ts";
import {
	type BuiltinTool,
	type ToolDefinition,
	validateToolArgs,
} from "./builtin-tool.ts";
import type { Dispatcher } from "./dispatcher.ts";
import { redactText } from "./errors.ts";
import type { McpRequestContext } from "./mcp-context.ts";
import { REGISTRY_NAMING, type ToolNaming } from "./tool-names.ts";

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
	account_id: {
		type: "string",
		maxLength: 255,
		pattern: "^biz_[A-Za-z0-9]+$",
		description: "The affected account (biz_...); defaults to the current one.",
	},
	intention: {
		type: "string",
		minLength: 1,
		maxLength: 2000,
		pattern: "\\S",
		description: "What you were trying to do, in one short sentence.",
	},
	tool: {
		type: "string",
		minLength: 1,
		maxLength: 200,
		pattern: "\\S",
		description: "The affected tool's exact name, if one tool is involved.",
	},
	modelType: {
		type: "string",
		minLength: 1,
		maxLength: 200,
		pattern: "\\S",
		description: "Your model and host product, if known.",
	},
};

function contentProperty(example: string) {
	return {
		type: "string",
		minLength: 1,
		maxLength: 12000,
		pattern: "\\S",
		description: `One plain note: the problem or question, what you expected, and only the IDs needed to reproduce it. Say what you ruled out only if it changes where to look. Example: "${example}"`,
	};
}

const annotations = {
	readOnlyHint: false,
	destructiveHint: false,
	idempotentHint: false,
	openWorldHint: true,
};

function feedbackDefinitions(naming: ToolNaming): ToolDefinition[] {
	const n = naming.name;
	return [
		{
			name: "report_feedback",
			description:
				"Report a problem with Whop or these tools (wrong result, confusing error, docs gap, odd API behavior) for Whop engineers to review. One per call. Returns a receipt only; nothing comes back. Never include credentials, secrets, personal data or payment details.",
			inputSchema: {
				type: "object",
				properties: {
					content: contentProperty(
						`${n("products_update")} cannot set a post-checkout redirect for prod_abc123, though ${n("checkout-configurations_create")} has redirect_url.`,
					),
					...commonProperties,
					severity: {
						type: "string",
						enum: ["blocked", "degraded", "cosmetic"],
						description:
							"Impact: blocked (could not finish), degraded (needed a slower path) or cosmetic (worked but confusing).",
					},
					workaround: {
						type: "string",
						minLength: 1,
						maxLength: 4000,
						pattern: "\\S",
						description: "What worked instead, if anything.",
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
				"Files a question for Whop's team to review. It returns a receipt only and never an answer, so do not wait or ask again. To get an answer, use docs_search and docs_query first; use this only for what the tools and docs could not answer. Never include credentials, secrets, personal data or payment details.",
			inputSchema: {
				type: "object",
				properties: {
					content: contentProperty(
						"Can a plan renew at a different price than it started at? The plans docs only cover new purchases.",
					),
					...commonProperties,
				},
				required: ["content"],
				additionalProperties: false,
			},
			annotations,
		},
	];
}

export const FEEDBACK_TOOLS = feedbackDefinitions(REGISTRY_NAMING);

type FeedbackAttribution = { clientName?: string; pluginSource?: string };

export function feedbackTools(
	dispatcher: Dispatcher,
	principal: PrincipalContext,
	attribution: FeedbackAttribution,
	naming: ToolNaming,
): BuiltinTool[] {
	return feedbackDefinitions(naming).map((definition) => ({
		definition,
		asksForIntent: true,
		call: async (args, _signal, mcpRequestContext) =>
			JSON.stringify(
				await submitFeedback(
					definition,
					args,
					principal,
					{
						record: (submission) =>
							postFeedback(dispatcher, submission, mcpRequestContext),
					},
					attribution,
				),
				null,
				2,
			),
	}));
}

async function postFeedback(
	dispatcher: Dispatcher,
	submission: FeedbackSubmission,
	mcpRequestContext: McpRequestContext | undefined,
): Promise<string> {
	const { content, ...fields } = submission.fields;
	const details = Object.entries({
		...fields,
		client: submission.clientName,
		plugin: submission.pluginSource,
	})
		.filter(([, value]) => value !== undefined)
		.map(([key, value]) => `${key}: ${value}`);
	const { body } = await dispatcher.postUnlisted(
		submission.kind,
		"/feedback_submissions",
		{
			account_id: submission.accountId ?? undefined,
			source: `mcp_${submission.kind}`,
			content: [content, ...details].join("\n\n"),
		},
		{ idempotencyKey: submission.id, mcpRequestContext },
	);
	const id = (body as { id?: unknown } | null)?.id;
	if (typeof id !== "string" || !id.startsWith("fbk_"))
		throw new Error("Invalid feedback receipt");
	return id;
}

export async function submitFeedback(
	tool: ToolDefinition,
	args: Record<string, unknown>,
	principal: PrincipalContext,
	sink: FeedbackSink,
	attribution: FeedbackAttribution,
) {
	validateToolArgs(tool, args);
	const submission: FeedbackSubmission = {
		id: crypto.randomUUID(),
		createdAt: new Date().toISOString(),
		kind: tool.name as FeedbackSubmission["kind"],
		userId: principal.userId,
		accountId: (args.account_id as string | undefined) ?? principal.accountId,
		...attribution,
		fields: Object.fromEntries(
			Object.entries(args)
				.filter(([key]) => key !== "account_id")
				.map(([key, value]) => [key, redactText(value as string)]),
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
