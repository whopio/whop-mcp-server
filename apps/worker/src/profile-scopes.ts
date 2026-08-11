// Vendored from developer-platform/packages/cli/src/auth/scopes.ts — the
// vetted user-grantable scope list for Whop's OAuth apps. Keep in sync when
// that file changes; requesting a name the OAuth server doesn't recognize
// fails the whole login with invalid_scope.
export const WHOP_SCOPES = [
	"access_pass:basic:read",
	"access_pass:create",
	"access_pass:delete",
	"access_pass:stats:read",
	"access_pass:update",
	"ad_campaign:basic:read",
	"ad_campaign:create",
	"ad_campaign:update",
	"affiliate:basic:read",
	"affiliate:create",
	"affiliate:update",
	"ai_chat:create",
	"ai_chat:delete",
	"ai_chat:read",
	"ai_chat:update",
	"ai_prompt:create",
	"audience:basic:read",
	"audience:update",
	"bounty:basic:read",
	"bounty:create",
	"chat:message:create",
	"chat:moderate",
	"chat:read",
	"checkout_configuration:basic:read",
	"checkout_configuration:create",
	"checkout_configuration:delete",
	"company:authorized_user:email:read",
	"company:authorized_user:read",
	"company:balance:export",
	"company:balance:read",
	"company:basic:read",
	"company:create",
	"company:delete",
	"company:log:read",
	"company:manage_checkout",
	"company:update",
	"company_token_transaction:create",
	"company_token_transaction:read",
	"course_analytics:read",
	"course_lesson_interaction:read",
	"courses:read",
	"courses:update",
	"custom_emoji:update",
	"developer:basic:read",
	"developer:create_app",
	"developer:logs:read",
	"developer:manage_builds",
	"developer:update_app",
	"dms:channel:manage",
	"dms:message:manage",
	"dms:read",
	"email",
	"event:create",
	"experience:attach",
	"experience:create",
	"experience:delete",
	"experience:detach",
	"experience:hidden_experience:read",
	"experience:update",
	"forum:moderate",
	"forum:post:create",
	"forum:read",
	"identity:read",
	"identity:write",
	"incorporation:read",
	"incorporation:write",
	"invoice:basic:read",
	"invoice:create",
	"invoice:update",
	"lead:basic:read",
	"lead:manage",
	"livestream:chat:read",
	"livestream:chat:write",
	"livestream:create",
	"livestream:delete",
	"livestream:manage_recording",
	"livestream:moderate",
	"media:generate",
	"media:read",
	"member:basic:read",
	"member:email:read",
	"member:journey:read",
	"member:manage",
	"member:moderate",
	"member:payment_methods:manage",
	"member:payment_methods:read",
	"member:phone:read",
	"member:stats:read",
	"membership:cancel",
	"membership:resync_access",
	"membership:update",
	"notification:create",
	"openid",
	"partner:basic:read",
	"partner:create",
	"payment:basic:read",
	"payment:charge",
	"payment:dispute",
	"payment:dispute:read",
	"payment:dispute_alert:read",
	"payment:manage",
	"payment:resolution_center",
	"payment:resolution_center_case:read",
	"payment:setup_intent:read",
	"payout:account:read",
	"payout:account:update",
	"payout:create_destination",
	"payout:delete_destination",
	"payout:destination:read",
	"payout:transfer:export",
	"payout:transfer:read",
	"payout:update_destination",
	"payout:withdraw_funds",
	"payout:withdrawal:read",
	"plan:basic:export",
	"plan:basic:read",
	"plan:create",
	"plan:delete",
	"plan:stats:export",
	"plan:stats:read",
	"plan:update",
	"plan:waitlist:export",
	"plan:waitlist:manage",
	"plan:waitlist:read",
	"profile",
	"promo_code:basic:export",
	"promo_code:basic:read",
	"promo_code:create",
	"promo_code:delete",
	"promo_code:update",
	"shipment:basic:read",
	"shipment:create",
	"social_account:create",
	"social_account:delete",
	"social_account:read",
	"social_link:update",
	"stats:read",
	"support_chat:create",
	"support_chat:message:create",
	"support_chat:read",
	"tracking_link:basic:export",
	"tracking_link:basic:read",
	"tracking_link:create",
	"tracking_link:delete",
	"tracking_link:stats:export",
	"tracking_link:stats:read",
	"tracking_link:update",
	"user:balance:read",
	"user:profile:update",
] as const;

// No email: userinfo's email is never consumed, so it is never requested.
const IDENTITY_SCOPES = ["openid", "profile"];

const GRANTABLE = new Set<string>(WHOP_SCOPES);

interface ScopedOperation {
	profiles: string[];
	scopes: string[];
	method: string;
	safety: { financial: boolean; credential: boolean };
}

function isReadNamedScope(scope: string): boolean {
	return /(:read|:export)$/.test(scope) || IDENTITY_SCOPES.includes(scope);
}

/**
 * Defense in depth against safety.yml drift: these financial/credential
 * capabilities are never requested for a non-admin credential, regardless of
 * how the registry classifies the operations that use them. A misclassified
 * row in metadata can hide or break a tool, but it can never silently put
 * money-moving or key-minting power on a read_only or standard token.
 */
const NON_ADMIN_SCOPE_DENYLIST = new Set([
	"payment:charge",
	"payment:manage",
	"payment:dispute",
	"payment:resolution_center",
	"payout:withdraw_funds",
	"payout:transfer_funds",
	"payout:create_destination",
	"payout:delete_destination",
	"payout:update_destination",
	"payout:account:update",
	"member:payment_methods:manage",
	"company_token_transaction:create",
	"crypto_wallet:swap",
	"media:generate",
	"company:update_child_fees",
	"developer:manage_api_key",
	"developer:manage_webhook",
]);

/**
 * Maps an MCP permission profile to the Whop OAuth scopes the worker requests
 * at the upstream authorize step. The downstream Whop token is bounded by the
 * profile even if tool filtering were bypassed — the profile is a capability
 * boundary on the credential, not just tool hiding.
 *
 * Base set: the union of the scopes declared by the operations visible in the
 * profile, filtered to the vetted grantable list. Two subtractions keep the
 * credential honest — some READ endpoints require write-capable scopes (e.g.
 * GET /transfers/recipients requires payout:withdraw_funds), and a union
 * alone would hand a read_only credential withdrawal capability:
 *
 *   read_only  drops every write-named scope. The handful of reads gated on
 *              write scopes (transfer recipients, api-key/webhook listings,
 *              swap status) fail with missing_scope — correct for read_only.
 *   standard   drops write-named scopes whose only requiring WRITE
 *              operations are financial/credential (those writes are
 *              admin-only, so standard must not hold their capability).
 *   admin      requests the full union.
 */
export function expandProfileToWhopScopes(
	profile: string,
	operations: ScopedOperation[],
): string[] {
	const writeScopeUsedByNonSensitiveWrite = new Set<string>();
	for (const operation of operations) {
		if (operation.method === "get") continue;
		if (operation.safety.financial || operation.safety.credential) continue;
		for (const scope of operation.scopes) {
			writeScopeUsedByNonSensitiveWrite.add(scope);
		}
	}

	const allowed = (name: string): boolean => {
		if (profile !== "admin" && NON_ADMIN_SCOPE_DENYLIST.has(name)) {
			return false;
		}
		if (isReadNamedScope(name)) return true;
		if (profile === "read_only") return false;
		if (profile === "standard") {
			return writeScopeUsedByNonSensitiveWrite.has(name);
		}
		return true;
	};

	const requested = new Set<string>(IDENTITY_SCOPES);
	for (const operation of operations) {
		if (!operation.profiles.includes(profile)) continue;
		for (const scope of operation.scopes) {
			const name = scope;
			if (GRANTABLE.has(name) && allowed(name)) requested.add(name);
		}
	}
	return [...requested].sort();
}

export { isProfileName, PROFILE_NAMES } from "@whop/mcp-server";
