import { DurableObject } from "cloudflare:workers";
import type {
	CompletedIdempotencyRecord,
	IdempotencyClaimInput,
	IdempotencyClaimResult,
	IdempotencyCompleteResult,
	IdempotencyRecord,
	IdempotencyReleaseResult,
	IdempotencyStore,
	IdempotencyUnknownResult,
	LegacyIdempotencyRecord,
	ReservedIdempotencyRecord,
	UnknownIdempotencyRecord,
} from "@whop/mcp-server";

const RECORD_TTL_MS = 24 * 60 * 60 * 1000;

type CompatibilityTerminalRecord = (
	| CompletedIdempotencyRecord
	| UnknownIdempotencyRecord
) & { ownerId: string };

function isCompletedRecord(
	record: IdempotencyRecord | null,
): record is CompletedIdempotencyRecord {
	return record?.version === 2 && record.state === "completed";
}

function isMissingRpcMethod(error: unknown, method: string): boolean {
	if (!(error instanceof Error)) return false;
	const rpcError = error as Error & {
		overloaded?: boolean;
		retryable?: boolean;
	};
	if (rpcError.overloaded || rpcError.retryable) return false;

	const message = error.message.toLowerCase();
	if (!message.includes(method.toLowerCase())) return false;
	return [
		"not a function",
		"no such method",
		"does not implement",
		"not implemented",
		"method not found",
	].some((phrase) => message.includes(phrase));
}

/**
 * One Durable Object per idempotency key serializes every state transition.
 * Records expire via alarm so abandoned keys do not accumulate.
 */
export class IdempotencyDO extends DurableObject {
	async get(): Promise<IdempotencyRecord | null> {
		return (await this.ctx.storage.get<IdempotencyRecord>("record")) ?? null;
	}

	async claim(
		input: IdempotencyClaimInput,
		options: { takeoverIncomplete: boolean },
	): Promise<IdempotencyClaimResult> {
		return this.ctx.storage.transaction(async (storage) => {
			const existing = await storage.get<IdempotencyRecord>("record");
			if (!existing) {
				const record: ReservedIdempotencyRecord = {
					version: 2,
					state: "reserved",
					...input,
				};
				await storage.put("record", record);
				await storage.setAlarm(Date.now() + RECORD_TTL_MS);
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
				await storage.put("record", record);
				await storage.setAlarm(Date.now() + RECORD_TTL_MS);
				return { status: "taken_over", record };
			}
			return { status: "existing", record: existing };
		});
	}

	async complete(
		ownerId: string,
		result: unknown,
		completedAt: string,
	): Promise<IdempotencyCompleteResult> {
		return this.ctx.storage.transaction(async (storage) => {
			const existing = await storage.get<IdempotencyRecord>("record");
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
			await storage.put("record", {
				version: 2,
				state: "completed",
				argsHash: existing.argsHash,
				callerKeyHash: existing.callerKeyHash,
				result,
				completedAt,
			});
			await storage.setAlarm(Date.now() + RECORD_TTL_MS);
			return "completed";
		});
	}

	async release(ownerId: string): Promise<IdempotencyReleaseResult> {
		return this.ctx.storage.transaction(async (storage) => {
			const existing = await storage.get<IdempotencyRecord>("record");
			if (
				existing?.version !== 2 ||
				existing.state !== "reserved" ||
				existing.ownerId !== ownerId
			) {
				return "stale";
			}
			await storage.delete("record");
			await storage.deleteAlarm();
			return "released";
		});
	}

	async markUnknown(
		ownerId: string,
		unknownAt: string,
	): Promise<IdempotencyUnknownResult> {
		return this.ctx.storage.transaction(async (storage) => {
			const existing = await storage.get<IdempotencyRecord>("record");
			if (
				existing?.version !== 2 ||
				existing.state !== "reserved" ||
				existing.ownerId !== ownerId
			) {
				return "stale";
			}
			await storage.put("record", {
				version: 2,
				state: "outcome_unknown",
				argsHash: existing.argsHash,
				callerKeyHash: existing.callerKeyHash,
				unknownAt,
			});
			await storage.setAlarm(Date.now() + RECORD_TTL_MS);
			return "marked_unknown";
		});
	}

	async put(
		record: LegacyIdempotencyRecord | CompatibilityTerminalRecord,
	): Promise<void> {
		await this.ctx.storage.transaction(async (storage) => {
			const existing = await storage.get<IdempotencyRecord>("record");
			if (record.version === 2) {
				if (
					existing?.version !== 2 ||
					existing.state !== "reserved" ||
					existing.ownerId !== record.ownerId ||
					existing.argsHash !== record.argsHash ||
					existing.callerKeyHash !== record.callerKeyHash
				) {
					return;
				}
				const { ownerId: _, ...terminalRecord } = record;
				await storage.put("record", terminalRecord);
				await storage.setAlarm(Date.now() + RECORD_TTL_MS);
				return;
			}
			if (existing?.version === 2) return;
			await storage.put("record", record);
			await storage.setAlarm(Date.now() + RECORD_TTL_MS);
		});
	}

	async reserve(
		record: LegacyIdempotencyRecord | ReservedIdempotencyRecord,
	): Promise<IdempotencyRecord | null> {
		return this.ctx.storage.transaction(async (storage) => {
			const existing = await storage.get<IdempotencyRecord>("record");
			if (existing) return existing;
			await storage.put("record", record);
			await storage.setAlarm(Date.now() + RECORD_TTL_MS);
			return null;
		});
	}

	async delete(ownerId?: string): Promise<void> {
		await this.ctx.storage.transaction(async (storage) => {
			const existing = await storage.get<IdempotencyRecord>("record");
			if (
				existing?.version === 2 &&
				(existing.state !== "reserved" || existing.ownerId !== ownerId)
			) {
				return;
			}
			await storage.delete("record");
			await storage.deleteAlarm();
		});
	}

	async alarm(): Promise<void> {
		await this.ctx.storage.deleteAll();
	}
}

export function durableIdempotencyStore(
	namespace: DurableObjectNamespace<IdempotencyDO>,
): IdempotencyStore {
	const stub = (key: string) => namespace.get(namespace.idFromName(key));
	return {
		get: (key) => stub(key).get(),
		claim: async (key, input, options) => {
			try {
				return await stub(key).claim(input, options);
			} catch (error) {
				if (!isMissingRpcMethod(error, "claim")) throw error;
				const object = stub(key);
				const record: ReservedIdempotencyRecord = {
					version: 2,
					state: "reserved",
					...input,
				};
				const existing = await object.reserve(record);
				if (!existing) return { status: "acquired", record };
				if (
					existing.version === 2 &&
					existing.state === "reserved" &&
					existing.argsHash === input.argsHash &&
					existing.callerKeyHash === input.callerKeyHash
				) {
					if (
						existing.ownerId !== input.ownerId &&
						!options.takeoverIncomplete
					) {
						return { status: "existing", record: existing };
					}
					return {
						status: options.takeoverIncomplete ? "taken_over" : "acquired",
						record: { ...existing, ownerId: input.ownerId },
					};
				}
				return { status: "existing", record: existing };
			}
		},
		complete: async (key, ownerId, result, completedAt) => {
			try {
				return await stub(key).complete(ownerId, result, completedAt);
			} catch (error) {
				if (!isMissingRpcMethod(error, "complete")) throw error;
				const existing = await stub(key).get();
				if (isCompletedRecord(existing)) {
					return "already_completed";
				}
				if (
					existing?.version !== 2 ||
					existing.state !== "reserved" ||
					existing.ownerId !== ownerId
				) {
					return "stale";
				}
				await stub(key).put({
					version: 2,
					state: "completed",
					argsHash: existing.argsHash,
					callerKeyHash: existing.callerKeyHash,
					ownerId,
					result,
					completedAt,
				});
				const completed = await stub(key).get();
				return isCompletedRecord(completed) ? "completed" : "stale";
			}
		},
		release: async (key, ownerId) => {
			try {
				return await stub(key).release(ownerId);
			} catch (error) {
				if (!isMissingRpcMethod(error, "release")) throw error;
				const existing = await stub(key).get();
				if (!existing) return "released";
				if (
					existing.version !== 2 ||
					existing.state !== "reserved" ||
					existing.ownerId !== ownerId
				) {
					return "stale";
				}
				await stub(key).delete(ownerId);
				return (await stub(key).get()) ? "stale" : "released";
			}
		},
		markUnknown: async (key, ownerId, unknownAt) => {
			try {
				return await stub(key).markUnknown(ownerId, unknownAt);
			} catch (error) {
				if (!isMissingRpcMethod(error, "markUnknown")) throw error;
				const existing = await stub(key).get();
				if (
					existing?.version !== 2 ||
					existing.state !== "reserved" ||
					existing.ownerId !== ownerId
				) {
					return "stale";
				}
				await stub(key).put({
					version: 2,
					state: "outcome_unknown",
					argsHash: existing.argsHash,
					callerKeyHash: existing.callerKeyHash,
					ownerId,
					unknownAt,
				});
				const unknown = await stub(key).get();
				return unknown?.version === 2 && unknown.state === "outcome_unknown"
					? "marked_unknown"
					: "stale";
			}
		},
	};
}
