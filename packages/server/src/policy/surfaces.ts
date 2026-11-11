import type { OperationDef } from "../registry/types.ts";

/**
 * A surface is a fixed subset of the registry served from its own endpoint.
 * Unlike permission profiles, it is chosen by the route the client connects
 * to, not by the user — so a directory listing can promise that a tool is
 * unreachable on that connection regardless of which profile was granted or
 * which headers the client sends. OAuth tokens issued for a surface's route
 * carry that route as their audience and are rejected on every other route.
 *
 *   full              every operation the profile and scopes allow
 *   claude_directory  the Anthropic plugin directory listing: no AI media
 *                     generation and no tool that moves money out of the
 *                     account. Selling, refunds, and disputes stay.
 *   chatgpt           the OpenAI plugin directory listing: the tools that run a
 *                     business on Whop, including AI media and domains. No
 *                     one-off customer charges, refunds, or money movement.
 *   muse              the Muse connector listing: the core operations /mcp
 *                     lists, minus those that move money (writes the safety
 *                     metadata marks financial), plus every read that read
 *                     scopes alone can run. Muse reviews and approves tools
 *                     one by one, so the only writes reachable are the
 *                     listed core ones, and its grant holds no other write
 *                     scopes.
 */
export const SURFACE_NAMES = [
	"full",
	"claude_directory",
	"chatgpt",
	"muse",
] as const;

export type SurfaceName = (typeof SURFACE_NAMES)[number];

export const DEFAULT_SURFACE: SurfaceName = "full";

/**
 * Operations removed from the Claude directory surface, keyed "METHOD /path".
 * Reads stay (listing past payouts is fine); every write that generates media
 * with an AI model, sends funds to someone else, funds an escrow, charges the
 * account's own stored payment method, or trades is removed.
 *
 * CHATGPT_EXCLUSIONS inherits these rows except AI media, so a new row here
 * comes off the ChatGPT route too.
 */
export const CLAUDE_DIRECTORY_EXCLUSIONS: ReadonlySet<string> = new Set([
	// AI image, video, and audio generation
	"POST /media/generate", // AI media generation
	// Transfers, payouts, and payout destinations
	"POST /transfers", // sends funds to another account
	"POST /claim_links/{id}/claim", // moves funds out of a transfer link
	"POST /payouts", // withdraws funds from the account
	"POST /payouts/quotes", // prepares a payout
	"POST /payouts/{id}/cancel", // payout management
	"POST /payouts/methods", // adds a payout destination
	"PATCH /payouts/methods/{id}", // changes a payout destination
	"DELETE /payouts/methods/{id}", // removes a payout destination
	"POST /cashback_rules/payout", // pays out cashback to other accounts
	// Handing a business to another owner hands over its balance with it
	"POST /accounts/{id}/transfer_ownership", // gives the account and its balance to another user
	// Bounties escrow and pay out their reward pool
	"POST /bounties", // escrows and pays out a reward pool
	"PATCH /bounties/{id}", // changes an escrowed reward pool
	"POST /bounties/{id}/cancel", // releases an escrowed reward pool
	// Spending instruments and balance top-ups from a stored method
	"POST /cards", // issues a spending card
	"PATCH /cards/{id}", // changes a spending card
	"POST /deposits", // can charge the account's stored payment method
	"POST /deposits/{id}/reverse", // sends a deposit back to its sender
	// Trading and currency conversion
	"POST /swaps", // trades or converts currency
	"POST /trades", // submits trading orders
	"POST /trades/{id}/cancel", // cancels trading orders
]);

/**
 * Operations removed from the ChatGPT surface, keyed "METHOD /path": everything
 * the Claude surface removes except AI media generation, plus the rows below.
 */
export const CHATGPT_EXCLUSIONS: ReadonlySet<string> = new Set([
	...[...CLAUDE_DIRECTORY_EXCLUSIONS].filter(
		(key) => key !== "POST /media/generate",
	),
	// Customer charges and refunds
	"POST /cashback_rule", // configures cashback funded from the platform balance
	"PATCH /cashback_rules/{id}", // changes a funded cashback rule
	"POST /company_token_transactions", // adds, subtracts, or transfers member tokens
	"POST /invoices", // creates a draft with payment_method_id, which issue or send then charges off-session
	"PATCH /invoices/{id}", // can set payment_method_id, which issue or send then charges off-session
	"POST /invoices/{id}/charge", // charges a buyer's saved payment method
	"POST /invoices/{id}/issue", // opens a draft invoice; one with a payment_method_id is charged off-session
	"POST /invoices/{id}/send", // emails a draft invoice; one with a payment_method_id is charged off-session
	"PATCH /memberships/{id}", // payment_method_id retries an open past-due payment right away
	"POST /payments", // charges a saved payment method off-session (financial transaction)
	"POST /payments/{id}/capture", // captures an authorization hold (completes a charge)
	"POST /payments/{id}/refund", // executes a refund (money out to the buyer)
	"POST /payments/{id}/retry", // re-charges the original payment method
	"POST /payments/{payment_id}/resume", // charges the saved card again; buyer-only, 403 for merchants
	"POST /resolution_center_cases/{id}/accept", // accepting a buyer claim generally refunds money
	"POST /setup_intents", // saves buyer payment methods and returns a client secret
	"PATCH /setup_intents/{setup_intent_id}/return_url", // buyer-side flow; accepts a client secret
	"POST /waitlist_entries/approve_all", // bulk approval may charge saved payment methods
	"POST /waitlist_entries/{id}/approve", // paid signups may charge their saved payment method
	// Buyers' saved payment methods
	"GET /confirmation_tokens/{id}", // buyer payment-method preview
	"GET /payment_methods", // buyers' saved payment instruments
	"GET /payment_methods/{id}", // a buyer's saved payment instrument
	"DELETE /payment_methods/{id}", // deletes a buyer's saved payment instrument (member:payment_methods:manage)
	"GET /payments/{payment_id}/status", // buyer polling endpoint; returns next_action with a client secret
	"GET /setup_intents", // saved payment method flows; returns a client secret
	"GET /setup_intents/{id}", // returns a client secret
	"GET /setup_intents/{setup_intent_id}/status", // returns next_action with a client secret
	// Other money actions
	"POST /account_links", // hosted payouts and KYC onboarding link; requires an API key
	"PATCH /accounts/{account_id}/fees", // sets fees charged to connected accounts
	"POST /disputes/{id}/accept", // concedes the chargeback to the customer (final)
	"POST /invoices/{id}/mark_uncollectible", // financial bookkeeping
	"POST /invoices/{id}/unschedule", // only useful with POST /invoices, which is excluded
	"POST /invoices/{id}/void", // financial bookkeeping
	"POST /memberships/{id}/apply_promo_code", // changes what the next invoice charges
	"POST /memberships/{id}/assign_affiliate", // changes commission attribution
	"POST /memberships/{id}/extend", // financial configuration (free days)
	"POST /memberships/{id}/reactivate", // financial configuration
	"POST /partner_referral_requests/{id}/accept", // financial (referral commission) acceptance
	"POST /partners/businesses/{id}/resend_invite", // ownership hand-off flow
	"POST /payment_quotes", // prices a payment for POST /payments, which is excluded
	"GET /payment_quotes/{id}", // only feeds POST /payments, which is excluded
	"PATCH /payments/{id}", // updates a shipping address or a buyer-flow return URL
	"POST /payments/{id}/void", // cancels a payment or releases a hold
	"PATCH /payments/{payment_id}/return_url", // buyer-side flow; accepts a client secret
	// Payout setup
	"POST /payouts/paypal_link_sessions", // starts linking a payout destination
	"GET /transfers/recipients", // only feeds transfers; requires payout:withdraw_funds
	// Credit applications
	"POST /financing_applications", // starts a credit/financing application
	"PATCH /financing_applications/{id}", // answers a financing application
	"POST /financing_applications/{id}/submit", // submits a financing application with legal acceptance
	// Ad runner reporting and the old ad payment retry
	"POST /ad_campaigns/{id}/retry_payment", // deprecated; POST /accounts/{id}/retry_ads_payment replaces it
	"POST /ad_issues", // reports why a runner's ad can't deliver; same family as POST /ad_stats
	"POST /ad_stats", // records an ad runner's stats and pays them for the spend
	// Identity documents, card data, and credentials
	"POST /access_tokens", // returns a bearer token
	"GET /ad_pixels", // ad_pixel:manage is not a grantable scope
	"POST /ad_pixels", // takes a Meta access token; ad_pixel:manage is not a grantable scope
	"GET /ad_pixels/{id}", // ad_pixel:manage is not a grantable scope
	"PATCH /ad_pixels/{id}", // takes a Meta access token; ad_pixel:manage is not a grantable scope
	"DELETE /ad_pixels/{id}", // ad_pixel:manage is not a grantable scope
	"PATCH /apps/{id}", // writes app secrets and OAuth redirect and scope config
	"GET /cards/{id}", // upstream returns card number, CVC, and PIN to the worker
	"GET /email_addresses", // the response can include mailbox passwords
	"POST /email_addresses", // the response includes the mailbox password
	"GET /email_addresses/{id}", // the response can include the mailbox password
	"PATCH /email_addresses/{id}", // the response includes the mailbox password
	"DELETE /email_addresses/{id}", // only useful with the other mailbox tools, which expose passwords
	"GET /email_addresses/{id}/mobileconfig", // an Apple profile that signs a device in to the mailbox
	"POST /email_addresses/{id}/reset_password", // sets and returns a new mailbox password
	"POST /verifications", // takes a tax ID, ID document images, a selfie, and a date of birth
	"PATCH /verifications/{id}", // same restricted identity inputs
	// Payout, card, crypto, credit, and identity reads
	"GET /accounts/{account_id}/financing_providers", // credit product reads
	"GET /card_transactions", // Whop Card spend product
	"GET /card_transactions/{id}", // Whop Card spend product
	"GET /cards", // Whop Card spend product; the schema declares card secrets
	"GET /claim_links/{id}", // transfer claim link
	"GET /financing_applications", // credit product reads
	"GET /financing_applications/{id}", // credit product reads
	"GET /identity_profiles", // identity profile data
	"GET /identity_profiles/{id}", // identity profile data
	"GET /identity_profiles/{id}/verifications", // identity profile data
	"GET /payout_accounts/{id}", // payout KYC profile
	"GET /payout_methods", // payout destinations (legacy)
	"GET /payout_methods/{id}", // payout destinations (legacy)
	"GET /payouts", // money-out history
	"GET /payouts/methods", // payout destinations (bank details)
	"GET /payouts/supported_methods", // payout setup
	"GET /payouts/{id}", // money-out history
	"GET /swaps", // crypto swaps; needs crypto_wallet scopes
	"POST /swaps/quote", // crypto swap preparation
	"GET /swaps/{id}", // crypto swaps
	"GET /trades", // trading reads
	"GET /trades/markets", // trading reads
	"GET /trades/{id}", // trading reads
	"GET /transfers", // money-out history
	"GET /transfers/{id}", // money-out history
	"GET /verifications", // identity profile data (DOB, address)
	"GET /verifications/{id}", // identity profile data
	// Paid account features and accepting terms
	"PATCH /accounts/{account_id}/preferences", // turns on paid services, sets ads payment methods and API keys
	"PATCH /partners/businesses/{id}", // commission advance projections; the scope is not grantable
	"POST /partners/businesses/{id}/accept_commission_advance", // accepts a CPA payment offer; the scope is not grantable
	"PATCH /users/me/preferences", // cards_auto_top_up moves funds; terms_accepted accepts Whop terms
	// Paid recommendations, logs, and similar reads
	"GET /accounts/{account_id}/preferences", // gated on write scopes; shows paid Economic Intelligence offers
	"GET /api_keys/permissions", // catalog only; this route has no API key tools
	"GET /apps/{id}/logs", // runtime logs may contain secrets an app printed
	"GET /economic_intelligence", // paid Whop service; listing queues AI generation
	"GET /users/{id}/recommend_actions", // promotional CTAs (start a business, become an affiliate)
	// Identity and paid-service writes
	"PATCH /economic_intelligence/{id}", // paid Whop service
	"DELETE /identity_profiles/{id}", // identity profile data
	// Whop AI chats, which can act outside this list
	"GET /ai_chats", // Whop AI chat management
	"POST /ai_chats", // sends free-form instructions to Whop AI
	"GET /ai_chats/{id}", // Whop AI chat management
	"PATCH /ai_chats/{id}", // Whop AI chat management
	"DELETE /ai_chats/{id}", // Whop AI chat management
	// Old duplicates that newer tools replace
	"GET /payment_method_domains", // deprecated; Apple Pay now goes through /domains
	"POST /payment_method_domains", // deprecated; Apple Pay now goes through /domains
	"GET /payment_method_domains/{id}", // deprecated; Apple Pay now goes through /domains
	"DELETE /payment_method_domains/{id}", // deprecated; Apple Pay now goes through /domains
	"POST /payment_method_domains/{id}/verify", // deprecated; Apple Pay now goes through /domains
	"GET /plans", // deprecated compatibility endpoint; use variants_*
	"POST /plans", // deprecated compatibility endpoint; use variants_*
	"GET /plans/{id}", // deprecated compatibility endpoint; use variants_*
	"PATCH /plans/{id}", // deprecated compatibility endpoint; use variants_*
	"DELETE /plans/{id}", // deprecated compatibility endpoint; use variants_*
	"POST /plans/{id}/calculate_tax", // deprecated compatibility endpoint; use variants_calculate_tax
	"GET /social_accounts", // deprecated compatibility endpoint; use external-accounts_*
	"POST /social_accounts", // deprecated compatibility endpoint; use external-accounts_*
	"POST /social_accounts/connect", // deprecated compatibility endpoint; use external-accounts_*
	"DELETE /social_accounts/{id}", // deprecated compatibility endpoint; use external-accounts_*
	"POST /social_accounts/{id}/refresh", // deprecated compatibility endpoint; use external-accounts_*
]);

/**
 * The ChatGPT surface also drops anything flagged financial or credential, so a
 * newly flagged operation stays off until someone decides to add it here.
 */
export const CHATGPT_FLAGGED_KEEP: ReadonlySet<string> = new Set([
	"POST /media/generate",
	"POST /domains",
	"PATCH /domains/{id}",
]);

/**
 * Writes this route reports as destructive although the shared safety rules
 * don't. OpenAI allows destructiveHint false only for additive writes with no
 * destructive or irreversible effect, and says being able to undo an action
 * doesn't justify it. Kept out of safety.yml so the other routes don't change.
 */
export const CHATGPT_DESTRUCTIVE_WRITES: ReadonlySet<string> = new Set([
	"DELETE /reactions/{id}",
	"PATCH /accounts/{id}",
	"PATCH /ad_campaigns/{id}",
	"PATCH /ad_groups/{id}",
	"PATCH /ads/{id}",
	"PATCH /affiliates/{id}/overrides/{override_id}",
	"PATCH /audiences/{id}",
	"PATCH /chat_channels/{id}",
	"PATCH /course_chapters/{id}",
	"PATCH /course_lessons/{id}",
	"PATCH /courses/{id}",
	"PATCH /dm_channels/{id}",
	"PATCH /dm_members/{id}",
	"PATCH /experiences/{id}",
	"PATCH /forum_posts/{id}",
	"PATCH /forums/{id}",
	"PATCH /leads/{id}",
	"PATCH /members/{id}",
	"PATCH /messages/{id}",
	"PATCH /payment_rules/{id}",
	"PATCH /products/{id}",
	"PATCH /shipments/{id}",
	"PATCH /users/me",
	"PATCH /users/me/preferences/notifications",
	"PATCH /users/{id}",
	"PATCH /variants/{id}",
	"POST /accounts/{id}/form_company",
	"POST /accounts/{id}/retry_ads_payment",
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
	"POST /affiliates",
	"POST /affiliates/{id}/archive",
	"POST /affiliates/{id}/overrides",
	"POST /affiliates/{id}/unarchive",
	"POST /bounty_submissions/{id}/submit",
	"POST /course_lessons/{lesson_id}/submit_assessment",
	"POST /experiences/{id}/detach",
	"POST /external_accounts",
	"POST /forum_posts",
	"POST /livestreams/{id}/unpin",
	"POST /memberships/{id}/resume",
	"POST /memberships/{id}/resync_access",
	"POST /messages",
	"POST /notifications/mark_read",
	"POST /partner_referral_requests",
	"POST /partners",
	"POST /payment_rules",
	"POST /payment_rules/{id}/activate",
	"POST /payment_rules/{id}/replace",
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
 * Writes that put something in front of the public although the shared safety
 * rules report them as staying inside the account. OpenAI asks for
 * openWorldHint true on public or open-ended entities. Kept out of safety.yml
 * so the other routes don't change.
 */
export const CHATGPT_OPEN_WORLD_WRITES: ReadonlySet<string> = new Set([
	"POST /app_builds/{id}/promote",
	"POST /apps/{id}/deploy",
	"POST /products/{id}/publish",
]);

const EXCLUSIONS: Record<SurfaceName, ReadonlySet<string>> = {
	full: new Set(),
	claude_directory: CLAUDE_DIRECTORY_EXCLUSIONS,
	chatgpt: CHATGPT_EXCLUSIONS,
	muse: new Set(),
};

export function isSurfaceName(value: string): value is SurfaceName {
	return (SURFACE_NAMES as readonly string[]).includes(value);
}

export function operationInSurface(
	operation: OperationDef,
	surface: SurfaceName,
): boolean {
	if (surface === "muse") {
		if (operation.annotations.readOnlyHint) return runsOnReadScopes(operation);
		return operation.core !== undefined && !movesMoney(operation);
	}
	const key = `${operation.method.toUpperCase()} ${operation.path}`;
	if (EXCLUSIONS[surface].has(key)) return false;
	if (surface !== "chatgpt") return true;
	const flagged = operation.safety.financial || operation.safety.credential;
	return !flagged || CHATGPT_FLAGGED_KEEP.has(key);
}

export function isReadNamedScope(scope: string): boolean {
	return /(:read|:export)$/.test(scope);
}

function runsOnReadScopes(operation: OperationDef): boolean {
	return operation.scopeAlternatives.some((alternative) =>
		alternative.every(isReadNamedScope),
	);
}

export function movesMoney(operation: OperationDef): boolean {
	return operation.safety.financial && !operation.annotations.readOnlyHint;
}
