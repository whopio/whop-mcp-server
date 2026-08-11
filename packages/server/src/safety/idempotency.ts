export interface IdempotencyClaimInput {
	argsHash: string;
	callerKeyHash: string;
	ownerId: string;
}

export interface ReservedIdempotencyRecord extends IdempotencyClaimInput {
	version: 2;
	state: "reserved";
}

export interface CompletedIdempotencyRecord {
	version: 2;
	state: "completed";
	argsHash: string;
	callerKeyHash: string;
	result: unknown;
	completedAt: string;
}

export interface UnknownIdempotencyRecord {
	version: 2;
	state: "outcome_unknown";
	argsHash: string;
	callerKeyHash: string;
	unknownAt: string;
}

export interface LegacyIdempotencyRecord {
	version?: never;
	argsHash: string;
	result?: unknown;
	completedAt?: string;
}

export type IdempotencyRecord =
	| ReservedIdempotencyRecord
	| CompletedIdempotencyRecord
	| UnknownIdempotencyRecord
	| LegacyIdempotencyRecord;

export interface IdempotencyClaimResult {
	status: "acquired" | "taken_over" | "existing";
	record: IdempotencyRecord;
}

export type IdempotencyCompleteResult =
	| "completed"
	| "already_completed"
	| "stale";

export type IdempotencyReleaseResult = "released" | "stale";
export type IdempotencyUnknownResult = "marked_unknown" | "stale";

export interface IdempotencyStore {
	get(key: string): Promise<IdempotencyRecord | null>;
	claim(
		key: string,
		input: IdempotencyClaimInput,
		options: { takeoverIncomplete: boolean },
	): Promise<IdempotencyClaimResult>;
	complete(
		key: string,
		ownerId: string,
		result: unknown,
		completedAt: string,
	): Promise<IdempotencyCompleteResult>;
	release(key: string, ownerId: string): Promise<IdempotencyReleaseResult>;
	markUnknown(
		key: string,
		ownerId: string,
		unknownAt: string,
	): Promise<IdempotencyUnknownResult>;
}

export class InMemoryIdempotencyStore implements IdempotencyStore {
	private readonly records = new Map<string, IdempotencyRecord>();

	async get(key: string): Promise<IdempotencyRecord | null> {
		return this.records.get(key) ?? null;
	}

	async claim(
		key: string,
		input: IdempotencyClaimInput,
		options: { takeoverIncomplete: boolean },
	): Promise<IdempotencyClaimResult> {
		const existing = this.records.get(key);
		if (!existing) {
			const record: ReservedIdempotencyRecord = {
				version: 2,
				state: "reserved",
				...input,
			};
			this.records.set(key, record);
			return { status: "acquired", record };
		}
		if (
			existing.version === 2 &&
			existing.state === "reserved" &&
			existing.argsHash === input.argsHash &&
			existing.callerKeyHash === input.callerKeyHash &&
			options.takeoverIncomplete
		) {
			const record = { ...existing, ownerId: input.ownerId };
			this.records.set(key, record);
			return { status: "taken_over", record };
		}
		return { status: "existing", record: existing };
	}

	async complete(
		key: string,
		ownerId: string,
		result: unknown,
		completedAt: string,
	): Promise<IdempotencyCompleteResult> {
		const existing = this.records.get(key);
		if (existing?.version === 2 && existing.state === "completed") {
			return "already_completed";
		}
		if (
			existing?.version !== 2 ||
			existing.state !== "reserved" ||
			existing.ownerId !== ownerId
		) {
			return "stale";
		}
		this.records.set(key, {
			version: 2,
			state: "completed",
			argsHash: existing.argsHash,
			callerKeyHash: existing.callerKeyHash,
			result,
			completedAt,
		});
		return "completed";
	}

	async release(
		key: string,
		ownerId: string,
	): Promise<IdempotencyReleaseResult> {
		const existing = this.records.get(key);
		if (
			existing?.version !== 2 ||
			existing.state !== "reserved" ||
			existing.ownerId !== ownerId
		) {
			return "stale";
		}
		this.records.delete(key);
		return "released";
	}

	async markUnknown(
		key: string,
		ownerId: string,
		unknownAt: string,
	): Promise<IdempotencyUnknownResult> {
		const existing = this.records.get(key);
		if (
			existing?.version !== 2 ||
			existing.state !== "reserved" ||
			existing.ownerId !== ownerId
		) {
			return "stale";
		}
		this.records.set(key, {
			version: 2,
			state: "outcome_unknown",
			argsHash: existing.argsHash,
			callerKeyHash: existing.callerKeyHash,
			unknownAt,
		});
		return "marked_unknown";
	}
}
