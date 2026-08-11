import type { PrincipalContext } from "../policy/types.ts";

export interface AuditEvent {
	at: string;
	toolName: string;
	operation: string;
	principalType: string;
	userId?: string;
	accountId: string | null;
	clientName?: string;
	requestId?: string;
	outcome: "executed" | "failed" | "prepared" | "replayed";
	errorCode?: string;
}

export interface AuditSink {
	record(event: AuditEvent): Promise<void>;
}

export class InMemoryAuditSink implements AuditSink {
	readonly events: AuditEvent[] = [];

	async record(event: AuditEvent): Promise<void> {
		this.events.push(event);
	}
}

export function auditEvent(
	toolName: string,
	operation: string,
	principal: PrincipalContext,
	outcome: AuditEvent["outcome"],
	extra: Partial<AuditEvent> = {},
): AuditEvent {
	return {
		at: new Date().toISOString(),
		toolName,
		operation,
		principalType: principal.principalType,
		userId: principal.userId,
		accountId: principal.accountId,
		outcome,
		...extra,
	};
}
