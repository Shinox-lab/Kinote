import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  acquireRoutingLease,
  routingLeases,
  blockActivity,
  captureChanges,
  captureFacts,
  captureMessages,
  captures,
  citations,
  jobs,
  suggestions,
  versions,
  withTenantTx,
} from '@living-wiki/db';
import { routeCapture } from '@living-wiki/core';
import { AppError } from '@living-wiki/contracts';
import type { CollabClient } from '@living-wiki/shared';
import { collabSettle, type CollabServer } from '../../collab/src/server.js';
import { startCollabServer } from '../../collab/test/support/wsClient.js';
import { InProcessCollabClient } from '../../api/test/support/inProcessCollab.js';
import { useTestDb } from '../../api/test/support/testkit.js';
import {
  addCapture,
  addRoutingSpace,
  embedder,
  liveBlockId,
  liveBlocks,
  livePage,
  model,
  routingWorld,
} from '../../../packages/core/test/fixtures/routingSeed.js';
import { blockText } from '../../../packages/core/src/index.js';
import type { BlockLike } from '@living-wiki/shared';
import { runPendingJobsForTenant } from '../src/runner.js';

describe('routeCapture', () => {
  let server: CollabServer;
  let collab: InProcessCollabClient;

  beforeAll(async () => {
    ({ server } = await startCollabServer(undefined, { debounceMs: 60_000, maxDebounceMs: 60_000 }));
    collab = new InProcessCollabClient(server);
  });
  useTestDb();
  afterEach(async () => {
    await collabSettle(server);
  });
  afterAll(async () => {
    await server.server.destroy();
  });

  const texts = (blocks: BlockLike[]) => blocks.map(blockText);
  const route = (tenantId: string, captureId: string, hooks?: { afterPlan?: () => Promise<void> }) =>
    routeCapture({ tenantId, captureId, holder: 'test' }, { model, embedder, collab, hooks });

  async function billingWorld(reviewRequired = false) {
    const w = await routingWorld();
    const eng = await addRoutingSpace(w, { name: 'Engineering', reviewRequired });
    const billing = await livePage(w, eng, 'Billing service', 'Billing uses Stripe.\n\nInvoices go out monthly.');
    return { w, eng, billing };
  }

  it('applies a change and cites the capture', async () => {
    const { w, billing } = await billingWorld();
    const block = await liveBlockId(w, billing.documentId, 'Billing uses Stripe');
    const captureId = await addCapture(w, w.userId, 'Billing moved to Adyen.');
    expect(await route(w.tenantId, captureId)).toBe('done');

    expect(texts(await liveBlocks(w, billing.documentId))).toEqual(['Billing moved to Adyen.', 'Invoices go out monthly.']);
    const [change] = await withTenantTx(w.tenantId, (tx) => tx.select().from(captureChanges));
    expect(change).toMatchObject({
      op: 'replace',
      blockId: block,
      beforeMarkdown: 'Billing uses Stripe.',
      afterMarkdown: 'Billing moved to Adyen.',
      status: 'applied',
    });
    const [cite] = await withTenantTx(w.tenantId, (tx) => tx.select().from(citations));
    expect(cite).toMatchObject({ sourceKind: 'capture', captureId, blockId: block, pageId: billing.documentId });
    const [version] = await withTenantTx(w.tenantId, (tx) =>
      tx.select().from(versions).where(eq(versions.id, change!.versionId!))
    );
    expect(version).toMatchObject({ reason: 'capture', status: 'indexing', createdByType: 'agent' });
    const [fact] = await withTenantTx(w.tenantId, (tx) => tx.select().from(captureFacts));
    expect(fact!.outcome).toBe('applied');
    const [capture] = await withTenantTx(w.tenantId, (tx) => tx.select().from(captures));
    expect(capture!.status).toBe('done');
  });

  it("splits outcomes by the target space's review setting", async () => {
    const w = await routingWorld();
    const eng = await addRoutingSpace(w, { name: 'Engineering' });
    const clients = await addRoutingSpace(w, { name: 'Clients', reviewRequired: true });
    const billing = await livePage(w, eng, 'Billing service', 'Billing uses Stripe.');
    const acme = await livePage(w, clients, 'Acme', 'Acme pays yearly.');
    const captureId = await addCapture(w, w.userId, 'Billing moved to Adyen. Acme now pays monthly.');
    expect(await route(w.tenantId, captureId)).toBe('done');

    const facts = await withTenantTx(w.tenantId, (tx) => tx.select().from(captureFacts).orderBy(captureFacts.ordinal));
    expect(facts.map((f) => f.outcome)).toEqual(['applied', 'waiting_review']);
    const changes = await withTenantTx(w.tenantId, (tx) => tx.select().from(captureChanges));
    const statusOf = async (documentId: string) => {
      const versionId = changes.find((c) => c.documentId === documentId)!.versionId!;
      const [v] = await withTenantTx(w.tenantId, (tx) => tx.select().from(versions).where(eq(versions.id, versionId)));
      return v!.status;
    };
    expect(await statusOf(billing.documentId)).toBe('indexing');
    expect(await statusOf(acme.documentId)).toBe('pending_review');
  });

  it('a removal becomes a suggestion and the text stays', async () => {
    const { w, billing } = await billingWorld();
    const block = await liveBlockId(w, billing.documentId, 'Billing uses Stripe');
    const captureId = await addCapture(w, w.userId, 'Billing no longer uses Stripe.');
    expect(await route(w.tenantId, captureId)).toBe('done');
    expect(texts(await liveBlocks(w, billing.documentId))).toContain('Billing uses Stripe.');
    const [s] = await withTenantTx(w.tenantId, (tx) => tx.select().from(suggestions));
    expect(s).toMatchObject({ kind: 'remove', blockId: block, blockedBy: 'removal', status: 'open', captureId });
    const [fact] = await withTenantTx(w.tenantId, (tx) => tx.select().from(captureFacts));
    expect(fact!.outcome).toBe('suggested');
  });

  it('a block a person changed after planning becomes a suggestion, not an overwrite', async () => {
    const { w, billing } = await billingWorld();
    const block = await liveBlockId(w, billing.documentId, 'Billing uses Stripe');
    const captureId = await addCapture(w, w.userId, 'Billing moved to Adyen.');
    const result = await route(w.tenantId, captureId, {
      async afterPlan() {
        await withTenantTx(w.tenantId, (tx) =>
          tx.insert(blockActivity).values({
            tenantId: w.tenantId, pageId: billing.documentId, blockId: block, actorType: 'user', actorId: w.userId,
          })
        );
      },
    });
    expect(result).toBe('done');
    expect(texts(await liveBlocks(w, billing.documentId))).toContain('Billing uses Stripe.');
    const [s] = await withTenantTx(w.tenantId, (tx) => tx.select().from(suggestions));
    expect(s).toMatchObject({ kind: 'replace', blockId: block, blockedBy: 'protection', proposedMarkdown: 'Billing moved to Adyen.' });
    expect(await withTenantTx(w.tenantId, (tx) => tx.select().from(captureChanges))).toEqual([]);
  });

  it('an edit a person makes just before the engine applies is never overwritten', async () => {
    const { w, billing } = await billingWorld();
    const block = await liveBlockId(w, billing.documentId, 'Billing uses Stripe');
    const captureId = await addCapture(w, w.userId, 'Billing moved to Adyen.');
    // The person's edit lands in collab after the recheck, right before the engine's own call.
    const racing: CollabClient = {
      flush: (n) => collab.flush(n),
      replaceBlocks: (a) => collab.replaceBlocks(a),
      setTitle: (a) => collab.setTitle(a),
      revoke: (t) => collab.revoke(t),
      async applyBlockOps(a) {
        if (a.actor.type === 'agent') {
          await collab.applyBlockOps({
            tenantId: a.tenantId,
            pageId: a.pageId,
            actor: { type: 'user', id: w.userId },
            source: 'human',
            ops: [{ op: 'replace', blockId: block, blocks: [{ id: 'p', type: 'paragraph', props: {}, content: [{ type: 'text', text: 'Billing uses Stripe in the EU.', styles: {} }], children: [] }] }],
          });
        }
        return collab.applyBlockOps(a);
      },
    };
    expect(await routeCapture({ tenantId: w.tenantId, captureId, holder: 'test' }, { model, embedder, collab: racing })).toBe('done');
    expect(texts(await liveBlocks(w, billing.documentId))).toContain('Billing uses Stripe in the EU.');
    const [s] = await withTenantTx(w.tenantId, (tx) => tx.select().from(suggestions));
    expect(s).toMatchObject({ kind: 'replace', blockId: block, blockedBy: 'protection' });
    expect(await withTenantTx(w.tenantId, (tx) => tx.select().from(captureChanges))).toEqual([]);
  });

  it('a second capture waits for the tenant lease', async () => {
    const { w } = await billingWorld();
    const captureId = await addCapture(w, w.userId, 'Billing moved to Adyen.');
    await withTenantTx(w.tenantId, (tx) => acquireRoutingLease(tx, w.tenantId, 'someone-else', 300));
    expect(await route(w.tenantId, captureId)).toBe('busy');
    const [capture] = await withTenantTx(w.tenantId, (tx) => tx.select().from(captures));
    expect(capture!.status).toBe('queued');

    // Through the job: still busy, so the job is put back for later.
    await withTenantTx(w.tenantId, (tx) =>
      tx.insert(jobs).values({
        tenantId: w.tenantId, queue: 'capture.route', idempotencyKey: `capture:${captureId}`,
        payload: { captureId }, status: 'queued', attempts: 0, maxAttempts: 5, runAt: new Date(),
      })
    );
    await runPendingJobsForTenant(w.tenantId, { collab, placementModel: model, embeddingProvider: embedder });
    const [job] = await withTenantTx(w.tenantId, (tx) =>
      tx.select().from(jobs).where(and(eq(jobs.tenantId, w.tenantId), eq(jobs.queue, 'capture.route')))
    );
    expect(job!.status).toBe('queued');
    expect(job!.runAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('a run that loses the tenant lease stops before applying anything', async () => {
    const { w, billing } = await billingWorld();
    const captureId = await addCapture(w, w.userId, 'Billing moved to Adyen.');
    await expect(
      route(w.tenantId, captureId, {
        async afterPlan() {
          // The lease ran out and another run took it.
          await withTenantTx(w.tenantId, async (tx) => {
            await tx.update(routingLeases).set({ expiresAt: new Date(Date.now() - 1000) });
            await acquireRoutingLease(tx, w.tenantId, 'other-run', 300);
          });
        },
      })
    ).rejects.toMatchObject({ code: 'router_unavailable' });
    expect(texts(await liveBlocks(w, billing.documentId))).toContain('Billing uses Stripe.');
    expect(await withTenantTx(w.tenantId, (tx) => tx.select().from(captureChanges))).toEqual([]);
  });

  it('a run retried after a failure past the edit neither repeats it nor loses its receipt', async () => {
    const { w, billing } = await billingWorld();
    const captureId = await addCapture(w, w.userId, 'Billing has a new dashboard.');
    let failFlush = true;
    const flaky: CollabClient = {
      flush: async (n) => {
        if (failFlush) {
          failFlush = false;
          throw new AppError('internal_error');
        }
        return collab.flush(n);
      },
      replaceBlocks: (a) => collab.replaceBlocks(a),
      applyBlockOps: (a) => collab.applyBlockOps(a),
      setTitle: (a) => collab.setTitle(a),
      revoke: (t) => collab.revoke(t),
    };
    const once = () => routeCapture({ tenantId: w.tenantId, captureId, holder: 'test' }, { model, embedder, collab: flaky });
    await expect(once()).rejects.toBeTruthy();
    expect(await once()).toBe('done');
    const live = texts(await liveBlocks(w, billing.documentId));
    expect(live.filter((t) => t === 'Billing has a new dashboard.')).toHaveLength(1);
    const changes = await withTenantTx(w.tenantId, (tx) => tx.select().from(captureChanges));
    expect(changes).toHaveLength(1);
    const [fact] = await withTenantTx(w.tenantId, (tx) => tx.select().from(captureFacts));
    expect(fact!.outcome).toBe('applied');
  });

  it('a question pauses only the facts that need the answer', async () => {
    const w = await routingWorld();
    const eng = await addRoutingSpace(w);
    const billing = await livePage(w, eng, 'Billing service', 'Billing uses Stripe.');
    await livePage(w, eng, 'Team', 'Aisha Rahman leads Payments.');
    await livePage(w, eng, 'People', 'Aisha Tan leads Search.');
    const captureId = await addCapture(w, w.userId, 'Aisha is on leave. Billing moved to Adyen.');
    expect(await route(w.tenantId, captureId)).toBe('waiting_for_answer');

    const facts = await withTenantTx(w.tenantId, (tx) => tx.select().from(captureFacts).orderBy(captureFacts.ordinal));
    expect(facts.map((f) => f.outcome)).toEqual(['pending', 'applied']);
    const [question] = await withTenantTx(w.tenantId, (tx) => tx.select().from(captureMessages));
    expect(question).toMatchObject({ author: 'engine', body: 'Which Aisha do you mean?' });
    expect(facts[0]!.waitingQuestionId).toBe(question!.id);
    expect(texts(await liveBlocks(w, billing.documentId))).toEqual(['Billing moved to Adyen.']);
    const [capture] = await withTenantTx(w.tenantId, (tx) => tx.select().from(captures));
    expect(capture!.status).toBe('waiting_for_answer');
  });
});
