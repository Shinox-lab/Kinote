import { and, eq } from 'drizzle-orm';
import { captures, documents, withTenantTx } from '@kinote/db';
import type { EmbeddingProvider } from '../embedding.js';
import type { RoutingModel } from '../placement/model.js';
import { senderActor, senderAccess } from './access.js';
import { failCapture, finishCapture } from './apply.js';
import { applyCaptureFilePlan, CAPTURE_FILE_MESSAGES, fileTitle, placedReason, type CaptureFilePlan } from './captureFile.js';
import { planDocument } from './document.js';

/** Why a file-only capture's file stayed in the Inbox when the agent named a place it can't add to. */
export const FILE_ONLY_NOT_EDITABLE = "Kept in your Inbox: you can't add files there.";

/**
 * Files a file-only capture (MCP `kinote_upload`): its file is placed on its own and no page is made, so its text
 * is never needed. The place is the page or space the sender named (scope), else where pages like the file's
 * description and name live; when nothing fits clearly it stays in the Inbox, with the reason and the likely places.
 * Returns false for any other capture, which routes as usual.
 */
export async function routeFileOnlyCapture(
  tenantId: string,
  captureId: string,
  deps: { model: RoutingModel; embedder: EmbeddingProvider }
): Promise<boolean> {
  const loaded = await withTenantTx(tenantId, async (tx) => {
    const [capture] = await tx.select().from(captures).where(and(eq(captures.tenantId, tenantId), eq(captures.id, captureId)));
    if (!capture?.fileOnly) return null;
    if (!capture.fileId) return { capture, name: '', editable: [] as string[] };
    const [file] = await tx.select({ title: documents.title, archivedAt: documents.archivedAt }).from(documents).where(and(eq(documents.tenantId, tenantId), eq(documents.id, capture.fileId)));
    const access = await senderAccess(tx, await senderActor(tx, { tenantId, type: capture.senderType, id: capture.senderId }));
    return { capture, name: file && !file.archivedAt ? file.title : '', editable: access.editable };
  });
  if (!loaded) return false;
  const { capture, name, editable } = loaded;
  // A rerun after the file was placed only settles the capture.
  if (capture.status === 'done' || capture.status === 'cancelled' || capture.fileOutcome !== null) {
    if (capture.status !== 'done' && capture.status !== 'cancelled') await finishCapture(tenantId, captureId);
    return true;
  }
  if (!name) {
    await failCapture(tenantId, captureId, CAPTURE_FILE_MESSAGES.gone);
    return true;
  }

  const inbox = (reason: string): CaptureFilePlan => ({ outcome: 'inbox', spaceId: null, parentId: null, reason });
  const named = async (spaceId: string, parentId: string | null): Promise<CaptureFilePlan> =>
    editable.includes(spaceId) ? { outcome: 'placed', spaceId, parentId, reason: await placedReason(tenantId, { spaceId, parentId }) } : inbox(FILE_ONLY_NOT_EDITABLE);

  let plan: CaptureFilePlan;
  if (capture.scopePageId) {
    plan = await named(capture.scopeSpaceId!, capture.scopePageId);
  } else if (capture.scopeSpaceId) {
    plan = await named(capture.scopeSpaceId, null);
  } else {
    const placed = await planDocument({ tenantId, captureId, title: fileTitle(name), subject: null, names: [], hint: null }, deps);
    if (placed.status === 'place') {
      plan = { outcome: 'placed', spaceId: placed.spaceId, parentId: placed.parentId, reason: await placedReason(tenantId, placed) };
    } else {
      const likely = placed.options.map((o) => `"${o.title}" (${o.spaceName}, ${o.pageId})`).join('; ');
      plan = inbox(`Kept in your Inbox: ${placed.reason}${likely ? ` Likely places: ${likely}.` : ''}`);
    }
  }
  await applyCaptureFilePlan(tenantId, captureId, plan);
  await finishCapture(tenantId, captureId);
  return true;
}
