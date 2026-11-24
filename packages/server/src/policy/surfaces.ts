import type { OperationDef } from "../registry/types.ts";
import { CHATGPT_FLAGGED_KEEP, CHATGPT_TOOLS } from "./chatgpt.ts";

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
 *   chatgpt           the OpenAI plugin directory listing: only the operations
 *                     in chatgpt-tools.json (each under its verbName with the
 *                     description given there). No one-off customer charges,
 *                     refunds, or money movement.
 *   muse              the Muse connector listing: the core operations /mcp
 *                     lists, minus writes that move money other than the refunds in
 *                     MUSE_REFUND_WRITES, plus every read that read scopes
 *                     alone can run. Muse reviews and approves tools one by
 *                     one, so the only writes reachable are listed ones, and
 *                     its grant holds no other write scopes.
 */
export const SURFACE_NAMES = [
	"full",
	"claude_directory",
	"chatgpt",
	"muse",
] as const;

export type SurfaceName = (typeof SURFACE_NAMES)[number];

export const DEFAULT_SURFACE: SurfaceName = "full";

export function operationKey(operation: {
	method: string;
	path: string;
}): string {
	return `${operation.method.toUpperCase()} ${operation.path}`;
}

/**
 * Operations removed from the Claude directory surface, keyed "METHOD /path".
 * Reads stay (listing past payouts is fine); every write that generates media
 * with an AI model, sends funds to someone else, funds an escrow, charges the
 * account's own stored payment method, or trades is removed.
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
 * Muse's guidelines ask connectors to support refunds where the product offers
 * them (section 1.1) and bar only transfers between accounts and trades
 * (section 4.6), so these two financial writes stay reachable on /muse/mcp.
 */
export const MUSE_REFUND_WRITES: ReadonlySet<string> = new Set([
	"POST /payments/{id}/refund",
	"POST /resolution_center_cases/{id}/accept",
]);

export function listedOnSurface(operation: OperationDef): boolean {
	return operation.core !== undefined;
}

export function isSurfaceName(value: string): value is SurfaceName {
	return (SURFACE_NAMES as readonly string[]).includes(value);
}

export function operationInSurface(
	operation: OperationDef,
	surface: SurfaceName,
): boolean {
	const key = operationKey(operation);
	if (surface === "muse") {
		if (operation.annotations.readOnlyHint) return runsOnReadScopes(operation);
		if (!listedOnSurface(operation)) return false;
		return !movesMoney(operation) || MUSE_REFUND_WRITES.has(key);
	}
	if (surface === "claude_directory") {
		return !CLAUDE_DIRECTORY_EXCLUSIONS.has(key);
	}
	if (surface === "chatgpt") {
		if (!Object.hasOwn(CHATGPT_TOOLS, key)) return false;
		const flagged = operation.safety.financial || operation.safety.credential;
		return !flagged || CHATGPT_FLAGGED_KEEP.has(key);
	}
	return true;
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
