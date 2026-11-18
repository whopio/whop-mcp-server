import type { Resource } from "@modelcontextprotocol/sdk/types.js";
import { FLOWS, type Flow, type FlowGroup } from "./flows.ts";
import {
	CALL_READ_OPERATION_TOOL,
	CALL_WRITE_OPERATION_TOOL,
	DESCRIBE_OPERATION_TOOL,
	SEARCH_OPERATIONS_TOOL,
} from "./operation-tools.ts";
import { canReach, type ToolReach, ToolNamer } from "./tool-reach.ts";

type Name = (tool: string) => string;

interface GuideResource extends Resource {
	/** Returns undefined when nothing in the guide is reachable. */
	render(reach: ToolReach): string | undefined;
}

const MARKDOWN = "text/markdown";
const URI_PREFIX = "whop://guides/";

function flowUsable(flow: Flow, reach: ToolReach): boolean {
	const reachable = (tool: string | undefined) =>
		!tool || canReach(reach, tool);
	const choices = flow.steps.filter((step) => step.choice);
	return (
		flow.steps.every((step) => step.optional || reachable(step.tool)) &&
		(!choices.length || choices.some((step) => reachable(step.tool)))
	);
}

const APPROVAL =
	"These steps change the user's live business. Show what will change and wait for a yes before each one that creates, changes, sends or deletes something.";

function renderFlow(flow: Flow, reach: ToolReach, name: Name): string {
	const steps = flow.steps
		.filter((step) => !step.tool || canReach(reach, step.tool))
		.map(
			(step, index) =>
				`${index + 1}. ${step.tool ? `${name(step.tool)}${step.choice ? " (one option)" : step.optional ? " (optional)" : ""}: ` : ""}${step.does}`,
		);
	return [
		`## ${flow.title}`,
		"",
		...steps,
		...(flow.note ? ["", flow.note] : []),
	].join("\n");
}

function withHint(text: string, namer: ToolNamer): string {
	return `${namer.withHint(text)}\n`;
}

function flowGuide(
	group: FlowGroup,
	heading: string,
	intro?: (name: Name) => string,
): (reach: ToolReach) => string | undefined {
	return (reach) => {
		const flows = FLOWS.filter(
			(flow) => flow.group === group && flowUsable(flow, reach),
		);
		if (!flows.length) return undefined;
		const namer = new ToolNamer(reach, true);
		const changes = flows.some((flow) =>
			flow.steps.some(
				(step) =>
					step.tool &&
					canReach(reach, step.tool) &&
					reach.writes.has(step.tool),
			),
		);
		const sections = [
			`# ${heading}`,
			...(intro ? [intro(namer.name)] : []),
			...(changes ? [APPROVAL] : []),
			...flows.map((flow) => renderFlow(flow, reach, namer.name)),
		];
		return withHint(sections.join("\n\n"), namer);
	};
}

const basics = (reach: ToolReach): string => {
	const namer = new ToolNamer(reach, true);
	const n = namer.name;
	const text = `# How Whop is organized

These are the objects the Whop tools read and change.

- **Business** (\`biz_\`): what the user runs on Whop. One user can manage several. ${n("accounts_list")} lists them, and tools that read or change a business take its \`account_id\`. If the user manages more than one business and hasn't said which, ask.
- **Product** (\`prod_\`): something the business sells, with a title, a description and a store page.
- **Variant** (\`plan_\`): one way to buy a product. It sets the price, the currency, and whether it's a one-time purchase or recurring. A product can have several variants, such as monthly and yearly. Each variant's \`purchase_url\` is its checkout link.
- **Experience** (\`exp_\`): an app inside the business that buyers use, such as a forum, a chat or a course. ${n("experiences_list")} lists them.
- **App** (\`app_\`): what an experience runs on, such as forums, chat or courses, plus apps from the Whop app store. ${n("apps_list")} searches the app store.
- **Membership** (\`mem_\`): created when someone buys a variant. Its \`status\` says whether it grants access.
- **Member** (\`mber_\`): a person in the business, with every membership they hold.
- **Payment** (\`pay_\`): one charge to a buyer.
- **Channel**: a chat, DM or support conversation.
- **Dispute** (\`dspt_\`): a buyer's bank challenging a payment.
- **Resolution center case**: a buyer's complaint or refund request in Whop's Resolution Center.
- **Promo code** (\`promo_\`): a discount buyers enter at checkout.
- **Checkout configuration** (\`ch_\`): a reusable checkout link for one variant, with extra settings such as where to send the buyer afterwards.

Prices are in the currency's normal units: \`24\` means $24.00, not 2,400 cents.

Everything this connection reads and changes is the user's live business. There is no test mode, so show the user what will change and wait for a yes before you create, change, send or delete anything.

Step-by-step guides for each job are the other \`${URI_PREFIX}\` resources.`;
	return withHint(text, namer);
};

const findingTools = (reach: ToolReach): string => {
	const namer = new ToolNamer(reach, true);
	const usedIn = new Map<string, string>();
	for (const flow of FLOWS.filter((candidate) =>
		flowUsable(candidate, reach),
	)) {
		for (const { tool } of flow.steps) {
			if (tool && reach.bySearch.has(tool) && !usedIn.has(tool)) {
				usedIn.set(tool, flow.title);
			}
		}
	}
	const rows = [...usedIn].map(
		([tool, flow]) => `| ${namer.name(tool)} | ${flow} |`,
	);
	const writesBySearch = [...reach.bySearch.values()].includes(
		CALL_WRITE_OPERATION_TOOL,
	);
	const text = [
		"# Finding tools that aren't listed",
		"",
		`The tool list shows the operations most jobs need. ${reach.bySearch.size} more ${writesBySearch ? "operations" : "reads"} are available without being listed:`,
		"",
		`1. \`${SEARCH_OPERATIONS_TOOL}\` finds them from a description in plain words, such as "membership details" or "case history".`,
		`2. \`${DESCRIBE_OPERATION_TOOL}\` shows one operation's inputs.`,
		`3. \`${CALL_READ_OPERATION_TOOL}\` runs a read${writesBySearch ? `, and \`${CALL_WRITE_OPERATION_TOOL}\` runs a write` : ""}, given its name and arguments.`,
		"",
		writesBySearch
			? "Search before telling the user Whop can't do something."
			: "Search before telling the user Whop can't show something. Writes that aren't listed can't run on this connection.",
		...(rows.length
			? [
					"",
					"The guides use these unlisted operations:",
					"",
					"| Operation | Used in |",
					"| --- | --- |",
					...rows,
				]
			: []),
	].join("\n");
	return `${text}\n`;
};

const SELLING_INTRO = (
	n: Name,
) => `A sale needs a product and at least one variant. The variant carries the price and the checkout link (its \`purchase_url\`).

For ${n("variants_create")}:

- One-time purchase: \`billing_type: "one_time"\` and \`initial_price\`.
- Recurring: \`billing_type: "renewal"\`, \`renewal_price\`, and \`billing_period\` in days (30 for monthly, 365 for yearly).
- Paid prices start at 1.00 in the variant's currency. Use 0 for a free variant. The currency defaults to USD.
- A free trial is \`trial_period_days\`.

${n("variants_list")} with \`product_ids\` shows a product's existing prices. Check it before adding a price the product may already have. To change a price later, use ${n("variants_update")}.

A custom checkout link adds \`redirect_url\` (where the buyer lands after paying), \`affiliate_code\` (credit an affiliate) or \`metadata\` (copied onto the payment and membership, to track where a sale came from).

Show the user the title, price and billing before you create anything, and wait for a yes.`;

const CUSTOMERS_INTRO = (
	n: Name,
) => `A membership is one purchase of one variant. A member can hold several.

| \`status\` | Has access | Meaning |
| --- | --- | --- |
| \`trialing\` | Yes | In a free trial. |
| \`active\` | Yes | Paid and current. |
| \`past_due\` | Yes | A payment failed. This is the grace period. |
| \`completed\` | Yes | A one-time purchase. Keeps access. |
| \`canceling\` | Yes | Asked to cancel. Keeps access until \`current_period_end\`. |
| \`canceled\` | No | Canceled. |
| \`expired\` | No | Ended. |

Other statuses can appear. Report them as the tool returns them rather than guessing what they mean.

Count \`canceling\` memberships as upcoming churn, not churn yet. In ${n("memberships_list")}, \`cancel_option\` is the reason the member picked and \`cancellation_reason\` is what they typed.

Draft every message, reply and decision for the user to approve before you send it. A refund, or accepting a buyer's claim, returns money: show the amount and currency and ask every time.`;

const BUSINESS_INTRO = (n: Name) =>
	`${n("stats_time-series_list")} lists the metric keys; ${n("stats_time-series_get")} charts one over a period. Keep a summary short: the key numbers, what changed, and one thing worth a closer look.`;

interface LimitItem {
	text: string;
	/** Omitted when this connection can call the tool. */
	unless?: string;
}

const LIMITS: readonly LimitItem[] = [
	{ text: "Payouts and withdrawals", unless: "payouts_create" },
	{ text: "Transfers to other people or accounts", unless: "transfers_create" },
	{
		text: "Adding or changing a payout method",
		unless: "payouts_create-method",
	},
	{
		text: "Charging a customer or sending an invoice",
		unless: "invoices_create",
	},
	{ text: "Buying or connecting a domain", unless: "domains_create" },
	{
		text: "Changing the business's website or rolling it back",
		unless: "app-builds_promote",
	},
	{
		text: "Uploading a file, such as a logo, a product image, a lesson video or dispute documents. Creating a file returns an upload URL, and the file's bytes have to be sent to it, which needs a client that can upload files",
	},
];

const connectorLimits = (reach: ToolReach): string => {
	const items = LIMITS.filter(
		(item) => !item.unless || !canReach(reach, item.unless),
	).map((item) => `- ${item.text}`);
	return `# What this connection can't do

Send the user to their Whop dashboard for:

${items.join("\n")}

Everything else acts on the user's live business: show what will change and wait for a yes first.
`;
};

const GUIDES: readonly GuideResource[] = [
	{
		uri: `${URI_PREFIX}basics`,
		name: "basics",
		title: "How Whop is organized",
		description:
			"The objects Whop tools work with: businesses, products, variants, experiences, members, memberships, payments, chats, disputes and promo codes.",
		mimeType: MARKDOWN,
		render: basics,
	},
	{
		uri: `${URI_PREFIX}finding-tools`,
		name: "finding-tools",
		title: "Finding tools that aren't listed",
		description:
			"How to find and run Whop operations that aren't in the tool list, and which ones the guides use.",
		mimeType: MARKDOWN,
		render: findingTools,
	},
	{
		uri: `${URI_PREFIX}business`,
		name: "business",
		title: "Knowing the business",
		description:
			"Revenue, members and churn over time, and Whop's recommended next steps.",
		mimeType: MARKDOWN,
		render: flowGuide("business", "Knowing the business", BUSINESS_INTRO),
	},
	{
		uri: `${URI_PREFIX}selling`,
		name: "selling",
		title: "Selling",
		description:
			"Products, prices, checkout links, promo codes, affiliates and the business's public details.",
		mimeType: MARKDOWN,
		render: flowGuide("selling", "Selling", SELLING_INTRO),
	},
	{
		uri: `${URI_PREFIX}customers`,
		name: "customers",
		title: "Customers and support",
		description:
			"Support chats, DMs, announcements, memberships and churn, refunds, buyer complaints, chargebacks and shipping.",
		mimeType: MARKDOWN,
		render: flowGuide("customers", "Customers and support", CUSTOMERS_INTRO),
	},
	{
		uri: `${URI_PREFIX}content`,
		name: "content",
		title: "Courses and apps",
		description: "Build and edit courses, and manage the apps buyers get.",
		mimeType: MARKDOWN,
		render: flowGuide("content", "Courses and apps"),
	},
	{
		uri: `${URI_PREFIX}website`,
		name: "website",
		title: "The business's website",
		description: "Update the business's website, or roll it back.",
		mimeType: MARKDOWN,
		render: flowGuide("website", "The business's website"),
	},
	{
		uri: `${URI_PREFIX}connector-limits`,
		name: "connector-limits",
		title: "What this connection can't do",
		description:
			"The actions to send to the Whop dashboard instead, such as payouts and file uploads.",
		mimeType: MARKDOWN,
		render: connectorLimits,
	},
];

export const GUIDE_URIS: readonly string[] = GUIDES.map((guide) => guide.uri);

export function listedResources(reach: ToolReach): Resource[] {
	return GUIDES.filter((guide) => guide.render(reach) !== undefined).map(
		({ render: _render, ...resource }) => resource,
	);
}

export function readResource(
	uri: string,
	reach: ToolReach,
): { uri: string; mimeType: string; text: string } | undefined {
	const guide = GUIDES.find((candidate) => candidate.uri === uri);
	const text = guide?.render(reach);
	if (!guide || text === undefined) return undefined;
	return { uri: guide.uri, mimeType: MARKDOWN, text };
}
