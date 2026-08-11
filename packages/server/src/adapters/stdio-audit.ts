import type { AuditEvent, AuditSink } from "../safety/audit.ts";

/** Writes audit events to stderr so stdout stays protocol-only. */
export class ConsoleErrorAuditSink implements AuditSink {
	async record(event: AuditEvent): Promise<void> {
		console.error(`[whop-mcp audit] ${JSON.stringify(event)}`);
	}
}
