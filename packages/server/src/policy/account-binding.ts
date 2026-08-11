import type { OperationDef } from "../registry/types.ts";
import { WhopMcpError } from "../runtime/errors.ts";
import type { PrincipalContext } from "./types.ts";

const ACCOUNT_ID_PATTERN = /^biz_[A-Za-z0-9]+$/;
const ACCOUNT_FIELD_PATTERN = /^(company_id|account_id|parent_company_id)$/;

/**
 * Account selection is a security boundary: when the connection is bound to
 * biz_A, any account-scoping field — at any depth of the input — referencing
 * biz_B is rejected even if the credential could technically access it, and
 * the bound account is injected wherever the operation accepts one, so the
 * model never chooses among businesses.
 *
 * Only account-named fields are checked. Other fields may legitimately carry
 * foreign biz_ IDs (child connected accounts, partner business references),
 * and the Whop API authorizes those against the credential itself.
 */
export function enforceAccountBinding(
	operation: OperationDef,
	args: Record<string, unknown>,
	principal: PrincipalContext,
): Record<string, unknown> {
	const bound = principal.accountId;

	checkAccountFields(args, bound, "$");

	if (operation.requiresAccount && !bound && !operation.accountParam) {
		throw new WhopMcpError(
			"account_required",
			`${operation.toolName} requires a selected business account, but this connection has none bound.`,
		);
	}

	if (
		operation.accountParam &&
		bound &&
		args[operation.accountParam] === undefined
	) {
		return { ...args, [operation.accountParam]: bound };
	}

	if (
		operation.accountParam &&
		operation.requiresAccount &&
		!bound &&
		args[operation.accountParam] === undefined
	) {
		throw new WhopMcpError(
			"account_required",
			`${operation.toolName} requires an account, and this connection has no bound account to inject.`,
		);
	}

	return args;
}

function checkAccountFields(
	value: unknown,
	bound: string | null,
	path: string,
): void {
	if (Array.isArray(value)) {
		value.forEach((item, i) =>
			checkAccountFields(item, bound, `${path}[${i}]`),
		);
		return;
	}
	if (value === null || typeof value !== "object") return;

	for (const [key, entry] of Object.entries(value)) {
		const entryPath = `${path}.${key}`;
		if (ACCOUNT_FIELD_PATTERN.test(key) && entry !== undefined) {
			if (typeof entry !== "string") {
				throw new WhopMcpError(
					"invalid_input",
					`${entryPath} must be an account ID string (biz_…).`,
				);
			}
			// "global" is the documented admin all-accounts mode. An unbound
			// connection may use it (the API authorizes it against the
			// credential's internal permissions), but a bound connection must
			// not: it would widen the boundary to every account the credential
			// can reach.
			if (entry !== "global" && !ACCOUNT_ID_PATTERN.test(entry)) {
				throw new WhopMcpError(
					"invalid_input",
					`${entryPath} must be an account ID (biz_…), got a malformed value.`,
				);
			}
			if (bound && entry !== bound) {
				throw new WhopMcpError(
					"account_mismatch",
					`This connection is bound to account ${bound}; input "${entryPath}" references ${entry}. Switching accounts requires the user to reconnect with a different account selected.`,
				);
			}
		}
		checkAccountFields(entry, bound, entryPath);
	}
}
