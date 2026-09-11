import type { OperationDef, RegistryManifest } from "../registry/types.ts";
import type { PrincipalContext } from "./types.ts";

export const WILDCARD_SCOPE = "*";

function scopesSatisfied(granted: string[], required: string[]): boolean {
	if (granted.includes(WILDCARD_SCOPE)) return true;
	return required.every((scope) => granted.includes(scope));
}

function scopeAlternativesSatisfied(
	granted: string[],
	alternatives: string[][],
): boolean {
	return alternatives.some((required) => scopesSatisfied(granted, required));
}

export interface VisibilityOptions {
	/**
	 * Restrict to the native REST surface. The legacy GraphQL-proxy surface is
	 * NOT redundant — payments, withdrawals, courses, community content, and
	 * more exist only there (true duplicates are excluded at generation time) —
	 * so the default exposes both. nativeOnly is for context-constrained
	 * clients that accept losing those capabilities for a smaller tool list.
	 */
	nativeOnly?: boolean;
}

export function operationVisibleToPrincipal(
	operation: OperationDef,
	principal: PrincipalContext,
	options: VisibilityOptions = {},
): boolean {
	return (
		(!options.nativeOnly || operation.surface === "native") &&
		operation.profiles.includes(principal.permissionProfile) &&
		operation.principals.includes(principal.principalType) &&
		scopeAlternativesSatisfied(principal.scopes, operation.scopeAlternatives)
	);
}

/**
 * The tool surface a connection actually sees: one canonical registry,
 * filtered by surface, permission profile, principal type, and granted
 * scopes.
 */
export function visibleOperations(
	registry: RegistryManifest,
	principal: PrincipalContext,
	options: VisibilityOptions = {},
): OperationDef[] {
	return registry.operations.filter((operation) =>
		operationVisibleToPrincipal(operation, principal, options),
	);
}
