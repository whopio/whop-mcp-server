import {
	ErrorCode,
	type GetPromptResult,
	McpError,
	type Prompt,
} from "@modelcontextprotocol/sdk/types.js";
import { canReach, type ToolReach, ToolNamer } from "./tool-reach.ts";

type PromptArgs = Record<string, string | undefined>;
type Name = (tool: string) => string;

export interface GuidePrompt {
	prompt: Prompt;
	/** Every tool the text names. The prompt is offered only when all are reachable. */
	requiredTools: readonly string[];
	render(args: PromptArgs, name: Name): string;
}

const MAX_ARGUMENT_LENGTH = 2000;

const BUSINESS_ARGUMENT = {
	name: "business",
	description:
		"Which business, if the user manages more than one. Leave empty to use the only one or be asked.",
	required: false,
};

function business(args: PromptArgs): string {
	return args.business ? `my business "${args.business}"` : "my Whop business";
}

const findBusiness = (n: Name) =>
	`Find the business with ${n("accounts_list")}. If I manage more than one and haven't said which, ask me.`;

const READ_ONLY = "Don't create or change anything.";
const ASK_FIRST = "wait for my yes";

const BILLING: Record<string, { label: string; variant: string }> = {
	one_time: {
		label: "as a one-time purchase",
		variant: 'billing_type "one_time" and initial_price',
	},
	monthly: {
		label: "monthly",
		variant: 'billing_type "renewal", renewal_price, and billing_period 30',
	},
	yearly: {
		label: "yearly",
		variant: 'billing_type "renewal", renewal_price, and billing_period 365',
	},
};

export const GUIDE_PROMPTS: readonly GuidePrompt[] = [
	{
		prompt: {
			name: "business_overview",
			title: "Business overview",
			description:
				"Revenue, new members, cancellations and recent sales over a period.",
			arguments: [
				BUSINESS_ARGUMENT,
				{
					name: "period",
					description:
						'The time to cover, such as "last 30 days" or "this month".',
					required: false,
				},
			],
		},
		requiredTools: [
			"accounts_list",
			"stats_time-series_list",
			"stats_time-series_get",
			"payments_list",
		],
		render: (args, n) =>
			[
				`Give me an overview of how ${business(args)} is doing over ${args.period ?? "the last 30 days"}.`,
				"",
				`1. ${findBusiness(n)}`,
				`2. Find the metric keys for revenue, new members and cancellations with ${n("stats_time-series_list")}, then chart each one over the period with ${n("stats_time-series_get")}.`,
				`3. Look at recent sales with ${n("payments_list")} and say which products sell best.`,
				"4. Keep it short: the key numbers, what changed, and one thing worth a closer look.",
				"",
				READ_ONLY,
			].join("\n"),
	},
	{
		prompt: {
			name: "next_steps",
			title: "What should I do next?",
			description:
				"Whop's recommended next steps for the business, explained in plain words.",
			arguments: [BUSINESS_ARGUMENT],
		},
		requiredTools: ["accounts_list", "recommended-actions_list"],
		render: (args, n) =>
			[
				`What should I do next with ${business(args)}?`,
				"",
				`1. ${findBusiness(n)}`,
				`2. Read the business's ready recommended actions with ${n("recommended-actions_list")} and statuses ready.`,
				"3. For the top three, say what each would change and why it should help.",
				"",
				`${READ_ONLY} If I pick one, show me exactly what it will change and wait for my go-ahead first.`,
			].join("\n"),
	},
	{
		prompt: {
			name: "create_product",
			title: "Create a product",
			description:
				"Create a product with a one-time or recurring price and get its checkout link.",
			arguments: [
				{ name: "name", description: "The product's title.", required: true },
				{
					name: "price",
					description:
						'The price, with its currency if not USD, such as "$24".',
					required: true,
				},
				{
					name: "billing",
					description: "one_time, monthly or yearly. Defaults to one_time.",
					required: false,
				},
				BUSINESS_ARGUMENT,
			],
		},
		requiredTools: ["accounts_list", "products_create", "variants_create"],
		render: (args, n) => {
			const billing = BILLING[args.billing ?? "one_time"];
			const how = billing ? billing.label : `billed ${args.billing}`;
			return [
				`Create a product called "${args.name}" for ${business(args)}, priced at ${args.price} ${how}.`,
				"",
				`1. ${findBusiness(n)}`,
				`2. Show me the title, price, currency and billing, and ${ASK_FIRST} before creating anything.`,
				`3. Create the product with ${n("products_create")}, then its price with ${n("variants_create")}${billing ? ` using ${billing.variant}` : ""}.`,
				"4. Give me the checkout link: the new variant's purchase_url.",
				"",
				"The details are in the whop://guides/selling resource.",
			].join("\n");
		},
	},
	{
		prompt: {
			name: "create_checkout_link",
			title: "Create a checkout link",
			description:
				"A checkout link for an existing price that sends buyers somewhere after they pay, credits an affiliate, or tags where sales came from.",
			arguments: [
				{
					name: "product",
					description: "The product to sell.",
					required: true,
				},
				{
					name: "redirect_url",
					description: "Where buyers land after paying.",
					required: false,
				},
				{
					name: "affiliate_code",
					description: "An affiliate to credit for sales through the link.",
					required: false,
				},
				{
					name: "tag",
					description:
						'A label for where sales came from, such as "spring-newsletter".',
					required: false,
				},
				BUSINESS_ARGUMENT,
			],
		},
		requiredTools: [
			"accounts_list",
			"products_list",
			"variants_list",
			"checkout-configurations_create",
		],
		render: (args, n) => {
			const settings = [
				args.redirect_url ? `redirect_url ${args.redirect_url}` : undefined,
				args.affiliate_code
					? `affiliate_code ${args.affiliate_code}`
					: undefined,
				args.tag ? `metadata { "source": "${args.tag}" }` : undefined,
			].filter((setting) => setting !== undefined);
			return [
				`Create a checkout link for "${args.product}" at ${business(args)}.`,
				"",
				`1. ${findBusiness(n)} Find the product with ${n("products_list")}, then its prices with ${n("variants_list")} and product_ids. If it has more than one price, ask me which.`,
				`2. Show me the product, the price and ${settings.length ? `these settings: ${settings.join(", ")}` : "any settings I asked for"}, and ${ASK_FIRST}.`,
				`3. Create it with ${n("checkout-configurations_create")}, passing account_id, variant_id and the settings.`,
				"4. Give me the new link: its purchase_url.",
			].join("\n");
		},
	},
	{
		prompt: {
			name: "launch_promo",
			title: "Launch a promo code",
			description: "Create a discount code for one product or all of them.",
			arguments: [
				{
					name: "discount",
					description: 'The discount, such as "20%" or "$10".',
					required: true,
				},
				{
					name: "product",
					description: "Limit to one product. Leave empty for all of them.",
					required: false,
				},
				{
					name: "code",
					description:
						"The code buyers type. Leave empty to have one suggested.",
					required: false,
				},
				BUSINESS_ARGUMENT,
			],
		},
		requiredTools: [
			"accounts_list",
			"products_list",
			"promo-codes_list",
			"promo-codes_create",
		],
		render: (args, n) =>
			[
				`Create a promo code at ${business(args)} for ${args.discount} off ${args.product ? `"${args.product}"` : "all products"}.${args.code ? ` Use the code ${args.code}.` : " Suggest a short code."}`,
				"",
				`1. ${findBusiness(n)}${args.product ? ` Find the product's id with ${n("products_list")}.` : ` If I name a product, find its id with ${n("products_list")}.`}`,
				`2. Check ${n("promo-codes_list")} for a code with the same name. If one exists, tell me and ask whether to pick another.`,
				`3. Show me the code, the discount, which products it covers, whether it's for new customers only, and how many months a recurring discount lasts. Ask me for anything I didn't say, and ${ASK_FIRST}.`,
				`4. Create it with ${n("promo-codes_create")}: promo_type percentage or flat_amount, amount_off, base_currency, code, new_users_only and promo_duration_months.`,
				"5. Tell me the code and that buyers enter it at checkout.",
			].join("\n"),
	},
	{
		prompt: {
			name: "update_business_details",
			title: "Update business details",
			description:
				"Change the business's public name, description, website, social links or URL.",
			arguments: [
				{
					name: "changes",
					description:
						'What to change, such as "new description: handmade candles from Maine".',
					required: true,
				},
				BUSINESS_ARGUMENT,
			],
		},
		requiredTools: ["accounts_list", "accounts_get", "accounts_update"],
		render: (args, n) =>
			[
				`Update ${business(args)}: ${args.changes}`,
				"",
				`1. ${findBusiness(n)} Read its current details with ${n("accounts_get")}.`,
				`2. Show me each field's current and new value side by side, and ${ASK_FIRST}. Changing route changes the business's public URL, so point that out if it's part of the change.`,
				`3. Save the change with ${n("accounts_update")}, sending only the fields that change.`,
				"4. Confirm what changed.",
			].join("\n"),
	},
	{
		prompt: {
			name: "answer_support_chats",
			title: "Answer support chats",
			description:
				"Go through the support chats waiting on the business, draft replies, and send the ones I approve.",
			arguments: [BUSINESS_ARGUMENT],
		},
		requiredTools: [
			"accounts_list",
			"channels_list",
			"messages_list",
			"messages_create",
			"channels_resolve",
		],
		render: (args, n) =>
			[
				`Help me answer the support chats waiting on ${business(args)}.`,
				"",
				`1. ${findBusiness(n)}`,
				`2. List them with ${n("channels_list")}: kind [support], support_role staff, account_id, and awaiting_reply true. Oldest first.`,
				`3. For each chat, read it with ${n("messages_list")} and draft a reply. Show me the customer's last message and your draft, and ${ASK_FIRST} before sending it with ${n("messages_create")}.`,
				`4. If the chat is handled, ask whether to close it with ${n("channels_resolve")}.`,
				"5. Skip any chat I say to skip, and tell me which ones are left.",
			].join("\n"),
	},
	{
		prompt: {
			name: "churn_check",
			title: "Check churn",
			description:
				"Memberships canceled or expired over a period, grouped by product and by the reason members gave.",
			arguments: [
				{
					name: "period",
					description: 'The time to cover, such as "last 30 days".',
					required: false,
				},
				{
					name: "product",
					description: "Limit to one product. Leave empty for all of them.",
					required: false,
				},
				BUSINESS_ARGUMENT,
			],
		},
		requiredTools: ["accounts_list", "products_list", "memberships_list"],
		render: (args, n) =>
			[
				`Which memberships${args.product ? ` to "${args.product}"` : ""} at ${business(args)} were canceled or expired over ${args.period ?? "the last 30 days"}?`,
				"",
				`1. ${findBusiness(n)} Use ${n("products_list")} to name products${args.product ? " and find this one's id" : ""}.`,
				`2. Call ${n("memberships_list")} with statuses canceled and expired${args.product ? " and that product in product_ids" : ""}. It filters by when a membership was created, so keep only the ones whose canceled_at falls in the period.`,
				"3. Group them by product and by cancel_option, and quote a few of the cancellation_reason texts.",
				"4. Separately, count memberships with status canceling: those members are leaving at the end of their billing period.",
				"",
				READ_ONLY,
			].join("\n"),
	},
	{
		prompt: {
			name: "manage_member",
			title: "Look after a customer",
			description:
				"Look up one customer's memberships and payments, then add a note, fix their access or get a receipt.",
			arguments: [
				{
					name: "member",
					description: "The customer's name, username or email.",
					required: true,
				},
				{
					name: "request",
					description:
						'What they need, such as "can\'t get into Discord" or "wants a receipt".',
					required: false,
				},
				BUSINESS_ARGUMENT,
			],
		},
		requiredTools: [
			"accounts_list",
			"members_list",
			"memberships_list",
			"payments_list",
			"members_notes_create",
			"memberships_resync_access",
			"payments_generate_pdf",
		],
		render: (args, n) =>
			[
				`Help me with this customer at ${business(args)}: ${args.member}${args.request ? `. They need: ${args.request}` : ""}`,
				"",
				`1. ${findBusiness(n)} Find the customer with ${n("members_list")} and query. If more than one could match, ask me which.`,
				`2. Show their memberships (${n("memberships_list")} with member_id) and recent payments (${n("payments_list")} with member_id).`,
				"3. Suggest what to do. The choices:",
				`   - If they paid but can't get in, re-grant access with ${n("memberships_resync_access")}.`,
				`   - For a receipt, get a PDF link for the payment with ${n("payments_generate_pdf")}. The link expires soon, so share it right away.`,
				`   - Leave a note for my team with ${n("members_notes_create")}.`,
				`4. Tell me what you'll do and ${ASK_FIRST} before each change.`,
			].join("\n"),
	},
	{
		prompt: {
			name: "refund_payment",
			title: "Refund a payment",
			description: "Refund all or part of a customer's payment.",
			arguments: [
				{
					name: "payment",
					description:
						'Which payment: its pay_ id, or the customer and what they bought, such as "Sam\'s March payment".',
					required: true,
				},
				{
					name: "amount",
					description: "A partial amount. Leave empty to refund it all.",
					required: false,
				},
				BUSINESS_ARGUMENT,
			],
		},
		requiredTools: [
			"accounts_list",
			"payments_list",
			"refunds_list",
			"payments_refund",
		],
		render: (args, n) =>
			[
				`Refund ${args.amount ? `${args.amount} of ` : ""}this payment at ${business(args)}: ${args.payment}`,
				"",
				`1. ${findBusiness(n)} Find the payment with ${n("payments_list")}. If more than one could match, ask me which.`,
				`2. Check ${n("refunds_list")} with its payment_id for an earlier refund.`,
				`3. Show me the buyer, the product, the amount and currency to refund, and whether that's all of it. Say the buyer is emailed and any affiliate commission is taken back. Wait for my yes every time.`,
				`4. Refund it with ${n("payments_refund")}${args.amount ? ", passing partial_amount" : ""}.`,
				`5. If the call fails or times out, check ${n("refunds_list")} again before retrying, so the payment isn't refunded twice.`,
			].join("\n"),
	},
	{
		prompt: {
			name: "handle_buyer_complaints",
			title: "Handle buyer complaints",
			description:
				"Go through the resolution center cases waiting on the business and answer, deny or accept each one.",
			arguments: [BUSINESS_ARGUMENT],
		},
		requiredTools: [
			"accounts_list",
			"resolution-center-cases_list",
			"resolution-center-cases_events",
			"resolution-center-cases_request_info",
			"resolution-center-cases_reply",
			"resolution-center-cases_deny",
			"resolution-center-cases_accept",
		],
		render: (args, n) =>
			[
				`Help me handle the buyer complaints waiting on ${business(args)}.`,
				"",
				`1. ${findBusiness(n)}`,
				`2. List them with ${n("resolution-center-cases_list")}: account_id and status [awaiting_merchant], ordered by response_due_at.`,
				`3. For each case, read its history with ${n("resolution-center-cases_events")}. Tell me the buyer, the amount, the reason, what they said and the deadline.`,
				"4. Suggest what to do and draft the message. The choices:",
				`   - Ask the buyer for more information with ${n("resolution-center-cases_request_info")}.`,
				`   - Answer Whop's request for information with ${n("resolution-center-cases_reply")}.`,
				`   - Reject the claim with ${n("resolution-center-cases_deny")}.`,
				`   - Accept it with ${n("resolution-center-cases_accept")}. This refunds the payment in full: show me the amount and currency.`,
				"5. Wait for my yes on every case before you act.",
			].join("\n"),
	},
	{
		prompt: {
			name: "respond_to_disputes",
			title: "Respond to chargebacks",
			description:
				"Disputes that need a response, with deadlines, and written evidence for the ones I want to fight.",
			arguments: [BUSINESS_ARGUMENT],
		},
		requiredTools: [
			"accounts_list",
			"disputes_list",
			"disputes_update",
			"disputes_submit",
		],
		render: (args, n) =>
			[
				`Help me respond to the chargebacks at ${business(args)}.`,
				"",
				`1. ${findBusiness(n)}`,
				`2. Call ${n("disputes_list")} with status needs_response and warning_needs_response. For each one, give the amount, the buyer, the product, the reason and evidence_due_at, soonest deadline first.`,
				`3. For a dispute I want to fight, draft the evidence. Show it to me and ${ASK_FIRST} before saving it with ${n("disputes_update")}.`,
				`4. Submitting with ${n("disputes_submit")} is final and locks the evidence. Ask me again before submitting.`,
				"",
				"Written evidence works here. Attaching documents needs the Whop dashboard.",
			].join("\n"),
	},
	{
		prompt: {
			name: "announce_to_members",
			title: "Announce to members",
			description: "Post an announcement in a forum or chat that members see.",
			arguments: [
				{
					name: "message",
					description: "What to announce.",
					required: true,
				},
				{
					name: "where",
					description:
						"The forum or chat to post in. Leave empty to choose from a list.",
					required: false,
				},
				BUSINESS_ARGUMENT,
			],
		},
		requiredTools: [
			"accounts_list",
			"experiences_list",
			"forum-posts_create",
			"messages_create",
		],
		render: (args, n) =>
			[
				`Post an announcement to the members of ${business(args)}${args.where ? ` in "${args.where}"` : ""}:`,
				"",
				args.message ?? "",
				"",
				`1. ${findBusiness(n)}`,
				`2. Find the forum or chat with ${n("experiences_list")}.${args.where ? "" : " If more than one fits, ask me which."}`,
				`3. Show me the final text and where it will go, and ${ASK_FIRST}. Ask before setting is_mention, which notifies everyone there.`,
				`4. In a forum, post with ${n("forum-posts_create")} (experience_id and content). In a chat, send it with ${n("messages_create")} (channel_id is the chat's experience id, and content).`,
				"5. Tell me where it was posted.",
			].join("\n"),
	},
	{
		prompt: {
			name: "moderate_community",
			title: "Moderate the community",
			description:
				"Review recent posts and messages in a forum or chat, then pin, hide, remove or tighten who can post.",
			arguments: [
				{
					name: "where",
					description:
						"The forum or chat to review. Leave empty to choose from a list.",
					required: false,
				},
				BUSINESS_ARGUMENT,
			],
		},
		requiredTools: [
			"accounts_list",
			"experiences_list",
			"forum-posts_list",
			"messages_list",
			"forum-posts_update",
			"forums_update",
			"messages_pin",
			"messages_delete",
		],
		render: (args, n) =>
			[
				`Help me moderate the community at ${business(args)}${args.where ? `, starting with "${args.where}"` : ""}.`,
				"",
				`1. ${findBusiness(n)}`,
				`2. Find the forum or chat with ${n("experiences_list")}.${args.where ? "" : " If more than one fits, ask me which."}`,
				`3. In a forum, read recent posts with ${n("forum-posts_list")}. In a chat, read recent messages with ${n("messages_list")} (channel_id is the chat's experience id).`,
				"4. Point out spam, abuse, off-topic posts and anything worth pinning. Suggest what to do:",
				`   - In a forum, pin, edit or hide a post with ${n("forum-posts_update")}, or limit who can post or comment, or add banned words, with ${n("forums_update")}.`,
				`   - In a chat, pin a message with ${n("messages_pin")} or remove one with ${n("messages_delete")}.`,
				`5. Show me each change and ${ASK_FIRST}. Removing a message can't be undone.`,
			].join("\n"),
	},
	{
		prompt: {
			name: "build_course",
			title: "Build a course",
			description:
				"Set up a course with chapters and lessons, and give a product's buyers access.",
			arguments: [
				{
					name: "topic",
					description:
						"What the course teaches, and an outline if there is one.",
					required: true,
				},
				{
					name: "product",
					description: "The product whose buyers get the course.",
					required: false,
				},
				BUSINESS_ARGUMENT,
			],
		},
		requiredTools: [
			"accounts_list",
			"apps_list",
			"experiences_list",
			"experiences_create",
			"courses_create",
			"course-chapters_create",
			"course-lessons_create",
			"products_list",
			"experiences_attach",
		],
		render: (args, n) =>
			[
				`Build a course for ${business(args)} about: ${args.topic}`,
				"",
				`1. ${findBusiness(n)}`,
				`2. Propose a title, chapters and lessons, and ${ASK_FIRST} on the outline.`,
				`3. Use a course app the business already has (${n("experiences_list")}), or find the Courses app with ${n("apps_list")} and query courses and add it with ${n("experiences_create")}.`,
				`4. Create the course with ${n("courses_create")}, each chapter with ${n("course-chapters_create")}, and each lesson with ${n("course-lessons_create")}. Video lessons can embed YouTube or Loom.`,
				`5. ${args.product ? `Find "${args.product}" with ${n("products_list")}` : `Ask which product's buyers should get the course, find it with ${n("products_list")},`} and give them access with ${n("experiences_attach")} once I say yes.`,
			].join("\n"),
	},
];

function promptReachable(guide: GuidePrompt, reach: ToolReach): boolean {
	return guide.requiredTools.every((tool) => canReach(reach, tool));
}

export function listedPrompts(reach: ToolReach): Prompt[] {
	return GUIDE_PROMPTS.filter((guide) => promptReachable(guide, reach)).map(
		(guide) => guide.prompt,
	);
}

export function renderPrompt(
	guide: GuidePrompt,
	args: PromptArgs,
	reach: ToolReach,
): string {
	const namer = new ToolNamer(reach, false);
	return namer.withHint(guide.render(args, namer.name));
}

export function getPrompt(
	name: string,
	args: PromptArgs,
	reach: ToolReach,
): GetPromptResult {
	const guide = GUIDE_PROMPTS.find(
		(candidate) =>
			candidate.prompt.name === name && promptReachable(candidate, reach),
	);
	if (!guide) {
		throw new McpError(ErrorCode.InvalidParams, `Unknown prompt "${name}".`);
	}
	const declared = guide.prompt.arguments ?? [];
	const known = new Set(declared.map((argument) => argument.name));
	const cleaned: PromptArgs = {};
	for (const [key, value] of Object.entries(args)) {
		if (!known.has(key)) {
			throw new McpError(
				ErrorCode.InvalidParams,
				`Prompt "${name}" has no argument "${key}".`,
			);
		}
		const trimmed = value?.trim();
		if (!trimmed) continue;
		if (trimmed.length > MAX_ARGUMENT_LENGTH) {
			throw new McpError(
				ErrorCode.InvalidParams,
				`Argument "${key}" is longer than ${MAX_ARGUMENT_LENGTH} characters.`,
			);
		}
		cleaned[key] = trimmed;
	}
	const missing = declared.filter(
		(argument) => argument.required && cleaned[argument.name] === undefined,
	);
	if (missing.length) {
		throw new McpError(
			ErrorCode.InvalidParams,
			`Prompt "${name}" needs ${missing.map((argument) => argument.name).join(", ")}.`,
		);
	}
	return {
		description: guide.prompt.description,
		messages: [
			{
				role: "user",
				content: { type: "text", text: renderPrompt(guide, cleaned, reach) },
			},
		],
	};
}
