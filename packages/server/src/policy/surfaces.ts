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
 */
export const SURFACE_NAMES = ["full", "claude_directory"] as const;

export type SurfaceName = (typeof SURFACE_NAMES)[number];

export const DEFAULT_SURFACE: SurfaceName = "full";

/**
 * Operations removed from the Claude directory surface, keyed "METHOD /path".
 * Reads stay (listing past payouts is fine); every write that generates media
 * with an AI model, sends funds to someone else, funds an escrow, charges the
 * account's own stored payment method, or trades is removed.
 */
export const CLAUDE_DIRECTORY_EXCLUSIONS: ReadonlyMap<string, string> = new Map(
	[
		// AI image, video, and audio generation
		["POST /media/generate", "AI media generation"],
		// Transfers, payouts, and payout destinations
		["POST /transfers", "sends funds to another account"],
		["POST /claim_links/{id}/claim", "moves funds out of a transfer link"],
		["POST /payouts", "withdraws funds from the account"],
		["POST /payouts/quotes", "prepares a payout"],
		["POST /payouts/{id}/cancel", "payout management"],
		["POST /payouts/methods", "adds a payout destination"],
		["PATCH /payouts/methods/{id}", "changes a payout destination"],
		["DELETE /payouts/methods/{id}", "removes a payout destination"],
		["POST /cashback_rules/payout", "pays out cashback to other accounts"],
		// Handing a business to another owner hands over its balance with it
		[
			"POST /accounts/{id}/transfer_ownership",
			"gives the account and its balance to another user",
		],
		// Bounties escrow and pay out their reward pool
		["POST /bounties", "escrows and pays out a reward pool"],
		["PATCH /bounties/{id}", "changes an escrowed reward pool"],
		["POST /bounties/{id}/cancel", "releases an escrowed reward pool"],
		// Spending instruments and balance top-ups from a stored method
		["POST /cards", "issues a spending card"],
		["PATCH /cards/{id}", "changes a spending card"],
		["POST /topups", "charges the account's stored payment method"],
		// Trading and currency conversion
		["POST /swaps", "trades or converts currency"],
		["POST /trades", "submits trading orders"],
	],
);

const EXCLUSIONS: Record<SurfaceName, ReadonlyMap<string, string>> = {
	full: new Map(),
	claude_directory: CLAUDE_DIRECTORY_EXCLUSIONS,
};

export function isSurfaceName(value: string): value is SurfaceName {
	return (SURFACE_NAMES as readonly string[]).includes(value);
}

export function operationInSurface(
	operation: OperationDef,
	surface: SurfaceName,
): boolean {
	return !EXCLUSIONS[surface].has(
		`${operation.method.toUpperCase()} ${operation.path}`,
	);
}
