import type { OperationSafety } from "../registry/types.ts";

/**
 * Permission profiles are policy rules over safety classifications, not
 * hand-curated tag lists — a new operation lands in the right profiles the
 * moment it is classified in metadata/safety.yml, with no per-profile upkeep.
 *
 *   read_only  reads plus write-shaped calculations (quotes, tax estimates)
 *   standard   everything reviewed EXCEPT money movement and credential/key
 *              material — the default for new connections
 *   admin      every reviewed operation; financial and credential writes
 *              require choosing this profile explicitly
 */
export const PROFILE_NAMES = ["read_only", "standard", "admin"] as const;

export type ProfileName = (typeof PROFILE_NAMES)[number];

export const DEFAULT_PROFILE: ProfileName = "standard";

export function isProfileName(value: string): value is ProfileName {
	return (PROFILE_NAMES as readonly string[]).includes(value);
}

export function profilesForSafety(safety: OperationSafety): ProfileName[] {
	const out: ProfileName[] = [];
	if (safety.classification === "read_only") out.push("read_only");
	if (!safety.financial && !safety.credential) out.push("standard");
	out.push("admin");
	return out;
}
