import chatgptTools from "./chatgpt-tools.json" with { type: "json" };

/**
 * Operations the ChatGPT route serves, keyed "METHOD /path" -> description.
 * OpenAI reviews each tool by name and description, so any operation absent
 * from chatgpt-tools.json is excluded from the ChatGPT route.
 */
export const CHATGPT_TOOLS: Readonly<Partial<Record<string, string>>> =
	chatgptTools;

/**
 * The ChatGPT surface drops anything flagged financial or credential, so a
 * newly flagged operation stays off even if listed in chatgpt-tools.json until
 * explicitly allowed here.
 */
export const CHATGPT_FLAGGED_KEEP: ReadonlySet<string> = new Set([
	"POST /domains",
	"PATCH /domains/{id}",
]);

/**
 * Field names the ChatGPT route neither accepts nor returns, at any depth:
 * government identifiers, dates of birth and card expiry. Card brand and last
 * four digits stay.
 */
export const CHATGPT_RESTRICTED_FIELDS: ReadonlySet<string> = new Set([
	"date_of_birth",
	"exp_month",
	"exp_year",
	"ssn",
	"tax_id_value",
	"tax_identifiers",
]);

/**
 * Secrets the ChatGPT route also removes from every result, at any depth. They
 * are not inputs of any tool there, so nothing is rejected for them.
 */
export const CHATGPT_HIDDEN_OUTPUTS: ReadonlySet<string> = new Set([
	"client_secret",
	"preview_token",
	"secret_key",
]);

/**
 * Objects whose own `token` the ChatGPT route removes from results. `token` is
 * too common a name to remove everywhere.
 */
export const CHATGPT_API_KEY_OBJECTS: ReadonlySet<string> = new Set([
	"api_key",
	"default_api_key",
]);

export interface ChatgptRemovedInput {
	path: readonly string[];
	instead: string;
}

const DOMAIN_SAVED_CARD: ChatgptRemovedInput = {
	path: ["registration", "payment_method_id"],
	instead:
		"The person pays on Whop's payment page, at the registration.purchase_url link this tool returns.",
};

/**
 * Per-operation inputs removed on the ChatGPT route. A domain is paid for on
 * Whop's payment page, never by charging a saved card from a chat.
 */
export const CHATGPT_REMOVED_INPUTS: Readonly<
	Partial<Record<string, readonly ChatgptRemovedInput[]>>
> = {
	"POST /domains": [DOMAIN_SAVED_CARD],
	"PATCH /domains/{id}": [DOMAIN_SAVED_CARD],
};

/**
 * Served writes this route reports as destructive although the shared safety
 * rules don't. OpenAI allows destructiveHint false only for additive writes
 * with no destructive or irreversible effect, and says being able to undo an
 * action doesn't justify it.
 */
export const CHATGPT_DESTRUCTIVE_WRITES: ReadonlySet<string> = new Set([
	"PATCH /accounts/{id}",
	"PATCH /ad_campaigns/{id}",
	"PATCH /ad_groups/{id}",
	"PATCH /ads/{id}",
	"PATCH /audiences/{id}",
	"PATCH /channel_members/{id}",
	"PATCH /channels/{id}",
	"PATCH /members/{id}",
	"PATCH /products/{id}",
	"PATCH /shipments/{id}",
	"PATCH /users/me",
	"PATCH /users/me/preferences/notifications",
	"PATCH /users/{id}",
	"PATCH /variants/{id}",
	"POST /ad_campaigns/{id}/claim",
	"POST /ad_campaigns/{id}/pause",
	"POST /ad_campaigns/{id}/unpause",
	"POST /ad_groups",
	"POST /ad_groups/{id}/duplicate",
	"POST /ad_groups/{id}/pause",
	"POST /ad_groups/{id}/unpause",
	"POST /ads",
	"POST /ads/{id}/duplicate",
	"POST /ads/{id}/pause",
	"POST /ads/{id}/unpause",
	"POST /channels/{id}/accept",
	"POST /channels/{id}/hide",
	"POST /channels/{id}/mark_read",
	"POST /channels/{id}/mark_unread",
	"POST /channels/{id}/reopen",
	"POST /channels/{id}/resolve",
	"POST /channels/{id}/unpin",
	"POST /memberships/{id}/resume",
	"POST /memberships/{id}/resync_access",
	"POST /partners",
	"POST /products/{id}/publish",
	"POST /products/{id}/unpublish",
	"POST /promo_codes",
	"POST /promo_codes/{id}/activate",
	"POST /promo_codes/{id}/deactivate",
	"POST /resolution_center_cases",
	"POST /resolution_center_cases/{id}/reply",
	"POST /resolution_center_cases/{id}/request_info",
	"POST /shipments",
	"POST /waitlist_entries/{id}/cancel",
	"POST /waitlist_entries/{id}/deny",
]);

/**
 * Served writes this route reports as open world although the shared safety
 * rules report them as staying inside the account. OpenAI's scan asks for
 * openWorldHint true on public or open-ended entities (ads, products, prices,
 * apps, checkout links, and account creation).
 */
export const CHATGPT_OPEN_WORLD_WRITES: ReadonlySet<string> = new Set([
	"PATCH /ad_campaigns/{id}",
	"PATCH /ad_groups/{id}",
	"PATCH /ads/{id}",
	"PATCH /products/{id}",
	"PATCH /variants/{id}",
	"POST /accounts",
	"POST /ad_campaigns/{id}/unpause",
	"POST /ad_groups/{id}/unpause",
	"POST /ads",
	"POST /ads/{id}/duplicate",
	"POST /ads/{id}/unpause",
	"POST /app_builds/{id}/promote",
	"POST /apps/{id}/deploy",
	"POST /checkout_configurations",
	"POST /products",
	"POST /products/{id}/publish",
	"POST /variants",
]);
