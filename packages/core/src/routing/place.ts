import { and, eq } from 'drizzle-orm';
import {
  withTenantTx,
  acquireRoutingLease,
  releaseRoutingLease,
  captureFacts,
  documents,
  routingExamples,
} from '@living-wiki/db';
import { AppError } from '@living-wiki/contracts';
import type { EmbeddingProvider } from '../embedding.js';
import { applyPlannedFacts, finishCapture, leaseGuard, ROUTING_LEASE_SECONDS, type RouteDeps } from './apply.js';
import { planCapture } from './plan.js';

/**
 * Files one fact on the page a person chose (from Needs a home, or "wrong
 * page → move to"): planned against that page only, the confidence floor
 * waived, every other rule kept. Takes the tenant's routing lease like a
 * capture does; `busy` when another run holds it.
 */
export async function placeFact(
  params: { tenantId: string; factId: string; documentId: string; holder: string },
  deps: RouteDeps
): Promise<'done' | 'busy'> {
  const { tenantId, factId, documentId, holder } = params;
  const got = await withTenantTx(tenantId, (tx) => acquireRoutingLease(tx, tenantId, holder, ROUTING_LEASE_SECONDS));
  if (!got) return 'busy';
  const guard = leaseGuard(tenantId, holder);
  try {
    const [fact] = await withTenantTx(tenantId, (tx) =>
      tx.select().from(captureFacts).where(and(eq(captureFacts.tenantId, tenantId), eq(captureFacts.id, factId)))
    );
    if (!fact) throw new AppError('capture_not_found');
    if (fact.outcome !== 'pending') return 'done';
    const planned = await planCapture(
      { tenantId, captureId: fact.captureId },
      {
        model: deps.model,
        embedder: deps.embedder,
        now: deps.now,
        onlyPage: documentId,
        guard,
        facts: [
          {
            ordinal: fact.ordinal,
            factId: fact.id,
            fact: { statement: fact.statement, kind: fact.kind, names: fact.names, date: fact.date },
            pinnedEntityIds: fact.pinnedEntityIds,
          },
        ],
      }
    );
    await applyPlannedFacts(tenantId, fact.captureId, planned, { ...deps, guard });
    await finishCapture(tenantId, fact.captureId);
    return 'done';
  } finally {
    await withTenantTx(tenantId, (tx) => releaseRoutingLease(tx, tenantId, holder));
  }
}

/** Saves a person's correction for the planner (or, for a document, the placement step) to see next time (R11). */
export async function recordRoutingExample(
  tenantId: string,
  example: {
    statement: string;
    chosenDocumentId: string;
    wrongDocumentId: string | null;
    createdBy: string;
    /** `document`: the chosen page is the parent a document's page went under. */
    kind?: 'fact' | 'document';
  },
  embedder: EmbeddingProvider
): Promise<void> {
  const [vector] = await embedder.embed([example.statement], 'document');
  await withTenantTx(tenantId, async (tx) => {
    const [doc] = await tx
      .select({ spaceId: documents.spaceId })
      .from(documents)
      .where(and(eq(documents.tenantId, tenantId), eq(documents.id, example.chosenDocumentId)));
    if (!doc) return;
    await tx.insert(routingExamples).values({
      tenantId,
      spaceId: doc.spaceId,
      kind: example.kind ?? 'fact',
      statement: example.statement,
      statementEmbedding: vector!,
      chosenDocumentId: example.chosenDocumentId,
      wrongDocumentId: example.wrongDocumentId,
      createdBy: example.createdBy,
    });
  });
}
