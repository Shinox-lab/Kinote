import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { captureFacts, captures, withTenantTx } from '@kinote/db';
import type { EmbeddingProvider } from '../embedding.js';
import type { FileDecision, RoutingModel } from '../placement/model.js';
import { CAPTURE_FILE_REASONS, decideKeepFile, planCaptureFile } from './captureFile.js';
import { planDocument, type DocumentPlan } from './document.js';
import { planCapture, type PlannedFact } from './plan.js';

type CaptureRow = typeof captures.$inferSelect;

/** What a previewed capture would do, stored on it until the sender applies or cancels it. */
export interface CapturePreview {
  version: 1;
  facts: PlannedFact[];
  /** Where a document capture's page would go; null for updates (or a page already made). */
  document: DocumentPlan | null;
  /** What would happen to an attached file; null without one. */
  file: { outcome: 'with_document' | 'placed' | 'inbox'; parentId: string | null; spaceId: string | null; reason: string } | null;
}

const PreviewSchema = z.object({
  version: z.literal(1),
  facts: z.array(
    z
      .object({
        ordinal: z.number().int(),
        factId: z.string().nullable(),
        fact: z.object({ statement: z.string() }).passthrough(),
        pinnedEntityIds: z.array(z.string()),
        plan: z.object({ status: z.string() }).passthrough(),
      })
      .passthrough()
  ),
  document: z.object({ status: z.enum(['place', 'needs_home']) }).passthrough().nullable(),
  file: z
    .object({
      outcome: z.enum(['with_document', 'placed', 'inbox']),
      parentId: z.string().nullable(),
      spaceId: z.string().nullable(),
      reason: z.string(),
    })
    .nullable(),
});

/** The stored preview of a capture; null when it has none, or what is stored is not one this version can read. */
export function previewOf(row: Pick<CaptureRow, 'previewPlan'>): CapturePreview | null {
  if (!row.previewPlan) return null;
  const parsed = PreviewSchema.safeParse(row.previewPlan);
  return parsed.success ? (row.previewPlan as CapturePreview) : null;
}

/**
 * Plans what a split capture would change, changing nothing: where its document page would go, what each fact
 * would do (with the pages it could also go to), and what becomes of its file. Model and embedder calls only.
 */
export async function buildCapturePreview(
  tenantId: string,
  capture: CaptureRow,
  deps: { model: RoutingModel; embedder: EmbeddingProvider; now?: Date; guard?: () => Promise<void> }
): Promise<CapturePreview> {
  const isDocument = capture.shape === 'document' && capture.documentOutcome !== 'created';
  let document: DocumentPlan | null = null;
  if (isDocument) {
    const names = await withTenantTx(tenantId, async (tx) =>
      (
        await tx
          .select({ names: captureFacts.names })
          .from(captureFacts)
          .where(and(eq(captureFacts.tenantId, tenantId), eq(captureFacts.captureId, capture.id)))
      ).flatMap((f) => f.names)
    );
    document = await planDocument(
      { tenantId, captureId: capture.id, title: capture.documentTitle ?? 'Capture', subject: capture.subject, names: [...new Set(names)] },
      deps
    );
  }
  const facts = await planCapture(
    { tenantId, captureId: capture.id },
    {
      model: deps.model,
      embedder: deps.embedder,
      ...(deps.now ? { now: deps.now } : {}),
      ...(deps.guard ? { guard: deps.guard } : {}),
      ...(isDocument ? { fromDocument: { pageId: null, title: capture.documentTitle ?? '' } } : {}),
    }
  );

  let file: CapturePreview['file'] = null;
  if (capture.fileId) {
    if (capture.shape === 'document') {
      const keep = decideKeepFile(capture.fileMode, 'document', capture.fileDecision as FileDecision | null);
      const at = document?.status === 'place' ? document : null;
      file =
        keep === 'inbox'
          ? { outcome: 'inbox', parentId: null, spaceId: null, reason: CAPTURE_FILE_REASONS.asked }
          : { outcome: 'with_document', parentId: null, spaceId: at?.spaceId ?? null, reason: CAPTURE_FILE_REASONS.withDocument };
    } else {
      const plan = await planCaptureFile(tenantId, capture, deps);
      file = { outcome: plan.outcome, parentId: plan.parentId, spaceId: plan.spaceId, reason: plan.reason };
    }
  }
  return { version: 1, facts, document, file };
}
