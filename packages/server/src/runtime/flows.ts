export type FlowGroup =
	| "business"
	| "selling"
	| "customers"
	| "content"
	| "website";

export interface FlowStep {
	/** Absent for a step the client does itself, such as building a site. */
	tool?: string;
	does: string;
	optional?: true;
	/** One of the flow's choices. A flow with choices needs at least one. */
	choice?: true;
}

export interface Flow {
	group: FlowGroup;
	title: string;
	steps: readonly FlowStep[];
	note?: string;
}

export const FLOWS: readonly Flow[] = [
	{
		group: "business",
		title: "How is my business doing?",
		steps: [
			{ tool: "accounts_list", does: "Pick the business." },
			{
				tool: "stats_time-series_list",
				does: "Find the metric keys for revenue, members and churn.",
			},
			{
				tool: "stats_time-series_get",
				does: "Chart a metric over the period.",
			},
			{ tool: "payments_list", does: "Look at recent sales." },
			{
				tool: "stats_reports_list",
				does: "Get totals that aren't charted over time.",
				optional: true,
			},
		],
	},
	{
		group: "business",
		title: "What should I do next?",
		steps: [
			{
				tool: "recommended-actions_list",
				does: "Pass `statuses` `ready` to read the recommended actions the business can act on now.",
			},
			{
				tool: "recommended-actions_dismiss",
				does: "Dismiss a recommended action the owner doesn't want.",
				optional: true,
			},
		],
	},
	{
		group: "selling",
		title: "Create a product and a way to buy it",
		steps: [
			{ tool: "products_create", does: "Create the product." },
			{ tool: "variants_create", does: "Add its price." },
			{
				tool: "checkout-configurations_create",
				does: "Make a checkout link with extra settings, if the variant's own `purchase_url` isn't enough.",
				optional: true,
			},
		],
	},
	{
		group: "selling",
		title: "Make a checkout link for something I already sell",
		steps: [
			{ tool: "products_list", does: "Find the product." },
			{ tool: "variants_list", does: "Find its price with `product_ids`." },
			{ tool: "checkout-configurations_create", does: "Create the link." },
			{
				tool: "checkout-configurations_list",
				does: "See the links the business already has.",
				optional: true,
			},
		],
	},
	{
		group: "selling",
		title: "Launch a promo code",
		steps: [
			{ tool: "products_list", does: "Pick the product, if it's for one." },
			{
				tool: "promo-codes_list",
				does: "Check the code isn't already taken.",
			},
			{ tool: "promo-codes_create", does: "Create the code." },
		],
	},
	{
		group: "selling",
		title: "Turn a promo code off, back on, or retire it",
		steps: [
			{ tool: "promo-codes_list", does: "Find the code." },
			{
				tool: "promo-codes_deactivate",
				does: "Turn it off.",
				optional: true,
				choice: true,
			},
			{
				tool: "promo-codes_activate",
				does: "Turn it back on.",
				optional: true,
				choice: true,
			},
			{
				tool: "promo-codes_delete",
				does: "Retire it.",
				optional: true,
				choice: true,
			},
		],
	},
	{
		group: "selling",
		title: "Retire a product, a price or a checkout link",
		steps: [
			{ tool: "products_list", does: "Find it." },
			{
				tool: "products_unpublish",
				does: "Take the product off the marketplace and keep it.",
				optional: true,
				choice: true,
			},
			{
				tool: "variants_delete",
				does: "Delete one price.",
				optional: true,
				choice: true,
			},
			{
				tool: "checkout-configurations_delete",
				does: "Delete a checkout link.",
				optional: true,
				choice: true,
			},
			{
				tool: "products_delete",
				does: "Delete the product.",
				optional: true,
				choice: true,
			},
		],
	},
	{
		group: "selling",
		title: "Update my business details",
		steps: [
			{ tool: "accounts_get", does: "Read the current details." },
			{
				tool: "accounts_update",
				does: "Change the name, description, links or URL.",
			},
		],
		note: "A new logo or banner is a file upload; see the connector-limits guide.",
	},
	{
		group: "selling",
		title: "Add an affiliate",
		steps: [
			{ tool: "members_list", does: "Find the person." },
			{ tool: "affiliates_create", does: "Make them an affiliate." },
			{
				tool: "affiliates_archive",
				does: "Stop one later.",
				optional: true,
			},
		],
	},
	{
		group: "customers",
		title: "Answer my unread support chats",
		steps: [
			{
				tool: "channels_list",
				does: "Pass `kind: [support]`, `support_role: staff`, `account_id` and `awaiting_reply: true`. Without `support_role: staff` it returns chats the user opened as a buyer.",
			},
			{ tool: "messages_list", does: "Read the conversation." },
			{
				tool: "messages_create",
				does: "Send the reply once the user approves it.",
			},
			{ tool: "channels_resolve", does: "Close the chat once it's handled." },
			{
				tool: "members_list",
				does: "`order: needs_reply` ranks customers waiting on a reply.",
				optional: true,
			},
		],
	},
	{
		group: "customers",
		title: "Work through DM requests",
		steps: [
			{
				tool: "channels_list",
				does: "Pass `kind: [private]` and `requested: true`.",
			},
			{
				tool: "channels_accept",
				does: "Accept a request.",
				optional: true,
				choice: true,
			},
			{
				tool: "channels_hide",
				does: "Decline one.",
				optional: true,
				choice: true,
			},
			{
				tool: "channels_mark_read",
				does: "Clear what's been handled.",
				optional: true,
			},
			{
				tool: "channels_reopen",
				does: "Reopen a resolved support chat.",
				optional: true,
			},
		],
	},
	{
		group: "customers",
		title: "DM a customer",
		steps: [
			{ tool: "members_list", does: "Find the customer." },
			{
				tool: "channels_create",
				does: "Pass `kind: private` and `participant_user_ids` with their `user_` id.",
			},
			{ tool: "messages_create", does: "Send the message." },
		],
	},
	{
		group: "customers",
		title: "Announce something to members",
		steps: [
			{ tool: "experiences_list", does: "Find the forum or chat." },
			{ tool: "forum-posts_create", does: "Post in a forum." },
			{
				tool: "messages_create",
				does: "Or post in a chat: its `channel_id` is the chat's experience id.",
				optional: true,
			},
		],
	},
	{
		group: "customers",
		title: "Notify members",
		steps: [
			{
				tool: "experiences_list",
				does: "Pick the app whose members to notify.",
			},
			{ tool: "notifications_create", does: "Send the notification." },
		],
	},
	{
		group: "customers",
		title: "Who churned, and what did they pay?",
		steps: [
			{
				tool: "memberships_list",
				does: "Pass `statuses` `canceled` and `expired`, then check each one's `canceled_at`. `canceling` ones leave at the end of their period.",
			},
			{ tool: "members_list", does: "See who they are." },
			{
				tool: "payments_list",
				does: "Pass `member_id` for one member's payments.",
			},
			{
				tool: "memberships_get",
				does: "Read one membership in detail.",
				optional: true,
			},
		],
	},
	{
		group: "customers",
		title: "Cancel, pause or resume a membership",
		steps: [
			{ tool: "memberships_list", does: "Find the membership." },
			{
				tool: "memberships_cancel",
				does: "Cancel it now, or at the end of the period with `cancel_at_period_end: true`.",
				optional: true,
				choice: true,
			},
			{
				tool: "memberships_pause",
				does: "Pause billing.",
				optional: true,
				choice: true,
			},
			{
				tool: "memberships_resume",
				does: "Restart billing.",
				optional: true,
				choice: true,
			},
		],
	},
	{
		group: "customers",
		title: "Refund a payment",
		steps: [
			{ tool: "payments_list", does: "Find the payment." },
			{
				tool: "refunds_list",
				does: "Pass `payment_id` to check it wasn't refunded already.",
			},
			{
				tool: "payments_refund",
				does: "Refund all of it, or part with `partial_amount`.",
			},
		],
		note: "A refund returns money and emails the buyer. Show the amount, currency, buyer and product and get a yes every time. If a refund call fails or times out, list the payment's refunds again before retrying.",
	},
	{
		group: "customers",
		title: "Handle a buyer complaint",
		steps: [
			{
				tool: "resolution-center-cases_list",
				does: "Find cases with `status: [awaiting_merchant]`.",
			},
			{
				tool: "resolution-center-cases_get",
				does: "Read the case.",
				optional: true,
			},
			{
				tool: "resolution-center-cases_events",
				does: "Read what the buyer said, in order.",
				optional: true,
			},
			{
				tool: "resolution-center-cases_request_info",
				does: "Ask the buyer for more information, up to three times.",
				optional: true,
				choice: true,
			},
			{
				tool: "resolution-center-cases_reply",
				does: "Answer when Whop asks the business for information.",
				optional: true,
				choice: true,
			},
			{
				tool: "resolution-center-cases_deny",
				does: "Reject the claim with no refund.",
				optional: true,
				choice: true,
			},
			{
				tool: "resolution-center-cases_accept",
				does: "Accept the claim, which refunds the payment in full.",
				optional: true,
				choice: true,
			},
		],
	},
	{
		group: "customers",
		title: "Respond to a chargeback",
		steps: [
			{
				tool: "disputes_list",
				does: "Find disputes that need a response, soonest `evidence_due_at` first.",
			},
			{ tool: "disputes_update", does: "Write the evidence." },
			{
				tool: "disputes_submit",
				does: "Send it to the processor. The evidence locks after this.",
			},
		],
		note: "Text evidence works. Attaching documents is a file upload; see the connector-limits guide.",
	},
	{
		group: "customers",
		title: "Add tracking to an order",
		steps: [
			{
				tool: "payments_list",
				does: "Pass `tracking_status: needs_tracking`.",
			},
			{ tool: "shipments_create", does: "Attach the tracking number." },
			{
				tool: "shipments_update",
				does: "Fix a wrong number.",
				optional: true,
			},
		],
	},
	{
		group: "content",
		title: "Build a course",
		steps: [
			{
				tool: "apps_list",
				does: "Pass `query: courses` to find the Courses app.",
			},
			{
				tool: "experiences_create",
				does: "Add a Courses app to the business.",
			},
			{ tool: "courses_create", does: "Create the course." },
			{ tool: "course-chapters_create", does: "Add chapters." },
			{ tool: "course-lessons_create", does: "Add lessons." },
			{
				tool: "experiences_attach",
				does: "Give a product's buyers access.",
			},
		],
		note: "Video lessons can embed YouTube or Loom. Uploading a video file is a file upload; see the connector-limits guide.",
	},
	{
		group: "content",
		title: "Edit a course",
		steps: [
			{ tool: "courses_list", does: "Find the course." },
			{ tool: "course-chapters_list", does: "List its chapters." },
			{ tool: "course-lessons_list", does: "List its lessons." },
			{ tool: "course-lessons_update", does: "Change a lesson." },
			{
				tool: "courses_update",
				does: "Rename the course or change its settings.",
				optional: true,
			},
			{
				tool: "course-lessons_delete",
				does: "Remove a lesson.",
				optional: true,
			},
			{
				tool: "course-chapters_delete",
				does: "Remove a chapter.",
				optional: true,
			},
		],
	},
	{
		group: "content",
		title: "Rename, move or remove an app",
		steps: [
			{ tool: "experiences_list", does: "Find the app." },
			{
				tool: "experiences_update",
				does: "Rename or move it.",
				optional: true,
				choice: true,
			},
			{
				tool: "experiences_detach",
				does: "Take it away from a product's buyers.",
				optional: true,
				choice: true,
			},
		],
	},
	{
		group: "website",
		title: "Update my website",
		steps: [
			{ tool: "apps_list", does: "Pass `account_id` to find the site's app." },
			{ tool: "app-builds_list", does: "Pass `app_id` to list its builds." },
			{
				tool: "app-builds_get",
				does: "Read the live build's `source_url` to download the code.",
			},
			{
				does: "Download, edit, build and zip the site. This needs a client with a shell.",
			},
			{
				tool: "files_create",
				does: "Get upload URLs, then send the zips' bytes to them.",
			},
			{ tool: "app-builds_create", does: "Register the build." },
			{ tool: "app-builds_promote", does: "Make it live." },
		],
	},
	{
		group: "website",
		title: "Roll my website back",
		steps: [
			{ tool: "apps_list", does: "Find the site's app." },
			{ tool: "app-builds_list", does: "Pick an earlier build." },
			{ tool: "app-builds_promote", does: "Make it live again." },
		],
	},
];
