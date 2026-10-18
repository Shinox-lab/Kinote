import { auditEvents } from './schema/foundations.js';
import type { DbTransaction } from './client.js';
import type { AuditEventType } from '@living-wiki/contracts';

export async function writeAuditEvent(
  tx: DbTransaction,
  params: {
    tenantId: string;
    type: AuditEventType;
    actorType: 'user' | 'agent' | 'connector' | 'system';
    actorId: string;
    subjectType: string;
    subjectId: string;
    payload?: Record<string, unknown>;
  }
) {
  const [event] = await tx
    .insert(auditEvents)
    .values({
      tenantId: params.tenantId,
      type: params.type,
      actorType: params.actorType,
      actorId: params.actorId,
      subjectType: params.subjectType,
      subjectId: params.subjectId,
      payload: params.payload ?? {},
    })
    .returning();
  return event;
}
