import type { FeedbackSink, FeedbackSubmission } from "@whop/mcp-server";

export class ApiFeedbackSink implements FeedbackSink {
	constructor(
		private readonly apiOrigin: string,
		private readonly accessToken: string,
	) {}

	async record(submission: FeedbackSubmission): Promise<string> {
		const { content, ...context } = submission.fields;
		const details = Object.entries({
			...context,
			client: submission.clientName,
			plugin: submission.pluginSource,
		})
			.filter(([, value]) => value !== undefined)
			.map(([key, value]) => `${key}: ${value}`);
		const response = await fetch(
			new URL("/api/v1/feedback_submissions", this.apiOrigin),
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${this.accessToken}`,
					"Content-Type": "application/json",
					"Idempotency-Key": submission.id,
				},
				body: JSON.stringify({
					source: `mcp_${submission.kind}`,
					content: [content, ...details].join("\n\n"),
				}),
				signal: AbortSignal.timeout(4000),
				redirect: "manual",
			},
		);
		if (!response.ok)
			throw new Error(`Feedback submission failed (${response.status})`);
		const receipt = await response.json<{ id?: string }>();
		if (typeof receipt.id !== "string" || !receipt.id.startsWith("fbk_"))
			throw new Error("Invalid feedback receipt");
		return receipt.id;
	}
}
