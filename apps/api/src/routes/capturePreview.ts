import { and, eq, inArray } from 'drizzle-orm';
import { captureFacts, captures, withTenantTx, writeAuditEvent } from '@kinote/db';
import { AppError, ApplyCapturePreviewRequestSchema, type CaptureDetail } from '@kinote/contracts';
import type { Actor } from '@kinote/core';
import { captureDetail, enqueueCaptureRoute, visibleCapture } from './captures.js';
import { enqueuePlace, targetPage } from './captureChanges.js';

/** The previewed capture, locked, for its sender (or its agent's owner); 409 `capture_not_previewed` otherwise. */
async function previewed(tx: Parameters<Parameters<typeof withTenantTx>[1]>[0], actor: Actor, id: string) {
  const row = await visibleCapture(tx, actor, id, { senderOnly: true, lock: true });
  if (row.status !== 'previewed' || !row.preview) throw new AppError('capture_not_previewed');
  return row;
}

/**
 * Files a previewed capture as planned: skipped facts are dismissed, placed facts are filed on the page chosen
 * (as Needs a home's "Place" does), and the rest is applied from the stored plan by the routing job. A block that
 * changed since the preview becomes a suggestion; nothing a person wrote is overwritten.
 */
export async function applyCapturePreview(actor: Actor, id: string, body: unknown): Promise<CaptureDetail> {
  const parsed = ApplyCapturePreviewRequestSchema.safeParse(body ?? {});
  return withTenantTx(actor.tenantId, async (tx) => {
    const row = await previewed(tx, actor, id);
    if (!parsed.success) throw new AppError('validation_failed');
    const { skip, place } = parsed.data;
    const named = [...new Set([...skip, ...place.map((p) => p.fact_id)])];
    if (named.length < skip.length + place.length) throw new AppError('validation_failed', 'Skip or place each fact once.');
    const facts = named.length
      ? await tx
          .select()
          .from(captureFacts)
          .where(and(eq(captureFacts.tenantId, actor.tenantId), eq(captureFacts.captureId, row.id), inArray(captureFacts.id, named)))
      : [];
    if (facts.length !== named.length || facts.some((f) => f.outcome !== 'pending')) {
      throw new AppError('validation_failed', 'Name facts of this preview that are still open.');
    }
    if (skip.length) {
      await tx
        .update(captureFacts)
        .set({ outcome: 'dismissed', reason: 'Skipped in the preview.' })
        .where(and(eq(captureFacts.tenantId, actor.tenantId), inArray(captureFacts.id, skip)));
    }
    for (const p of place) {
      await targetPage(tx, actor, p.document_id, 'viewer');
      await tx
        .update(captureFacts)
        .set({ outcome: 'pending', placedBy: actor.principalId, reason: null })
        .where(and(eq(captureFacts.tenantId, actor.tenantId), eq(captureFacts.id, p.fact_id)));
      await enqueuePlace(tx, actor.tenantId, p.fact_id, p.document_id);
    }
    const [after] = await tx
      .update(captures)
      .set({ preview: false, status: 'queued', finishedAt: null })
      .where(and(eq(captures.tenantId, actor.tenantId), eq(captures.id, row.id)))
      .returning();
    await enqueueCaptureRoute(tx, actor.tenantId, row.id);
    await writeAuditEvent(tx, {
      tenantId: actor.tenantId,
      type: 'capture.preview_applied',
      actorType: actor.principalType,
      actorId: actor.principalId,
      subjectType: 'capture',
      subjectId: row.id,
      payload: { skipped: skip.length, placed: place.length },
    });
    return captureDetail(tx, actor, after!);
  });
}

/** Drops a previewed capture: every fact is dismissed and nothing is filed. */
export async function cancelCapturePreview(actor: Actor, id: string): Promise<CaptureDetail> {
  return withTenantTx(actor.tenantId, async (tx) => {
    const row = await previewed(tx, actor, id);
    await tx
      .update(captureFacts)
      .set({ outcome: 'dismissed', reason: 'The preview was cancelled.' })
      .where(and(eq(captureFacts.tenantId, actor.tenantId), eq(captureFacts.captureId, row.id), eq(captureFacts.outcome, 'pending')));
    const [after] = await tx
      .update(captures)
      .set({ status: 'cancelled' })
      .where(and(eq(captures.tenantId, actor.tenantId), eq(captures.id, row.id)))
      .returning();
    await writeAuditEvent(tx, {
      tenantId: actor.tenantId,
      type: 'capture.preview_cancelled',
      actorType: actor.principalType,
      actorId: actor.principalId,
      subjectType: 'capture',
      subjectId: row.id,
      payload: {},
    });
    return captureDetail(tx, actor, after!);
  });
}
