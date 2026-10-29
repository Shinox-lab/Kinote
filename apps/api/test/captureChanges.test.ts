import { describe, test, beforeAll, afterEach, afterAll, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { withTenantTx, captureChanges, captureFacts, routingExamples, versions } from '@living-wiki/db';
import { DeterministicEmbeddingProvider, DeterministicPlacementModel, blockText } from '@living-wiki/core';
import type { BlockLike, CollabClient } from '@living-wiki/shared';
import { collabSettle, type CollabServer } from '../../collab/src/server.js';
import { startCollabServer } from '../../collab/test/support/wsClient.js';
import { readBlocks } from '../../collab/test/support/blocks.js';
import { storedDoc } from '../../collab/test/support/collabWorld.js';
import { runPendingJobsForTenant } from '../../worker/src/runner.js';
import { InProcessCollabClient } from './support/inProcessCollab.js';
import { bootstrapTenant, buildTestApp, signUpMember, useTestDb } from './support/testkit.js';

type Headers = Record<string, string>;

describe('undo, wrong page and needs a home', () => {
  let server: CollabServer;
  let collab: InProcessCollabClient;
  let app: ReturnType<typeof buildTestApp>;
  const model = new DeterministicPlacementModel();
  const embedder = new DeterministicEmbeddingProvider();

  beforeAll(async () => {
    ({ server } = await startCollabServer(undefined, { debounceMs: 60_000, maxDebounceMs: 60_000 }));
    collab = new InProcessCollabClient(server);
    app = buildTestApp({ collab, embeddingProvider: embedder });
  });
  useTestDb();
  afterEach(async () => {
    await collabSettle(server);
  });
  afterAll(async () => {
    await server.server.destroy();
  });

  const post = (headers: Headers, url: string, payload: unknown = {}) =>
    app.inject({ method: 'POST', url, headers, payload: payload as any });
  const get = (headers: Headers, url: string) => app.inject({ method: 'GET', url, headers });

  async function world() {
    const { tenant, owner, headers } = await bootstrapTenant(app, { name: 'Undo Co', slug: 'undo-co' });
    const space = (await post(headers, '/api/v1/spaces', { name: 'Eng', slug: 'eng' })).json().id as string;
    const other = (await post(headers, '/api/v1/spaces', { name: 'Ops', slug: 'ops' })).json().id as string;
    const page = async (spaceId: string, slug: string, markdown: string) =>
      (await post(headers, '/api/v1/pages', { space_id: spaceId, title: slug, slug, markdown })).json().id as string;
    const billing = await page(space, 'billing', 'Billing uses Stripe.\n\nInvoices go out monthly.');
    const runbook = await page(other, 'runbook', 'Page the on-call.');
    return { tenant, owner, headers, space, other, billing, runbook };
  }

  const run = (tenantId: string) =>
    runPendingJobsForTenant(tenantId, { collab, placementModel: model, embeddingProvider: embedder });

  async function capture(w: Awaited<ReturnType<typeof world>>, text: string, pageId = w.billing) {
    const res = await post(w.headers, '/api/v1/captures', { text, scope_page_id: pageId });
    expect(res.statusCode, res.body).toBe(201);
    await run(w.tenant.id);
    return res.json().id as string;
  }

  const live = async (tenantId: string, pageId: string) =>
    (readBlocks(await storedDoc(tenantId, pageId)) as BlockLike[]).map(blockText);
  const changesOf = (tenantId: string, captureId: string) =>
    withTenantTx(tenantId, (tx) => tx.select().from(captureChanges).where(eq(captureChanges.captureId, captureId)));
  const factsOf = (tenantId: string, captureId: string) =>
    withTenantTx(tenantId, (tx) => tx.select().from(captureFacts).where(eq(captureFacts.captureId, captureId)));

  test('undo restores the before text as a new version', async () => {
    const w = await world();
    const id = await capture(w, 'Billing moved to Adyen.');
    expect(await live(w.tenant.id, w.billing)).toEqual(['Billing moved to Adyen.', 'Invoices go out monthly.']);
    const [change] = await changesOf(w.tenant.id, id);
    const before = await withTenantTx(w.tenant.id, (tx) => tx.select().from(versions).where(eq(versions.documentId, w.billing)));

    const res = await post(w.headers, `/api/v1/capture-changes/${change!.id}/undo`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ undone: [change!.id], changedSince: [] });
    expect(await live(w.tenant.id, w.billing)).toEqual(['Billing uses Stripe.', 'Invoices go out monthly.']);
    const after = await withTenantTx(w.tenant.id, (tx) => tx.select().from(versions).where(eq(versions.documentId, w.billing)));
    expect(after.length).toBe(before.length + 1);
    expect((await changesOf(w.tenant.id, id))[0]!.status).toBe('undone');
    expect((await factsOf(w.tenant.id, id))[0]!.outcome).toBe('undone');

    const again = await post(w.headers, `/api/v1/capture-changes/${change!.id}/undo`);
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe('change_already_undone');
  });

  test('undo skips blocks changed since and reports them', async () => {
    const w = await world();
    const id = await capture(w, 'Billing moved to Adyen. Invoices now go out weekly.');
    const changes = await changesOf(w.tenant.id, id);
    expect(changes).toHaveLength(2);
    const billingChange = changes.find((c) => c.afterMarkdown.includes('Adyen'))!;
    const invoiceChange = changes.find((c) => c.afterMarkdown.includes('weekly'))!;
    // A person rewrites the Adyen block after the engine did.
    await collab.applyBlockOps({
      tenantId: w.tenant.id,
      pageId: w.billing,
      actor: { type: 'user', id: w.owner.userId },
      source: 'human',
      ops: [
        {
          op: 'replace',
          blockId: billingChange.blockId,
          blocks: [{ id: 'x', type: 'paragraph', props: {}, content: [{ type: 'text', text: 'Billing uses Adyen and PayPal.', styles: {} }], children: [] }],
        },
      ],
    });

    const res = await post(w.headers, `/api/v1/captures/${id}/undo`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ undone: [invoiceChange.id], changedSince: [billingChange.id] });
    expect(await live(w.tenant.id, w.billing)).toEqual(['Billing uses Adyen and PayPal.', 'Invoices go out monthly.']);
  });

  test('move removes the block from the wrong page, places it on the chosen page and records an example', async () => {
    const w = await world();
    const id = await capture(w, 'Billing has a new dashboard.');
    const [change] = await changesOf(w.tenant.id, id);
    expect(change!.op).toBe('insert');
    const res = await post(w.headers, `/api/v1/capture-changes/${change!.id}/move`, { target_page_id: w.runbook });
    expect(res.statusCode, res.body).toBe(200);
    await run(w.tenant.id);
    expect(await live(w.tenant.id, w.billing)).toEqual(['Billing uses Stripe.', 'Invoices go out monthly.']);
    expect(await live(w.tenant.id, w.runbook)).toEqual(['Page the on-call.', 'Billing has a new dashboard.']);
    const statuses = (await changesOf(w.tenant.id, id)).map((c) => [c.documentId, c.status]).sort();
    expect(statuses).toEqual([[w.billing, 'moved'], [w.runbook, 'applied']].sort());
    const [example] = await withTenantTx(w.tenant.id, (tx) => tx.select().from(routingExamples));
    expect(example).toMatchObject({ chosenDocumentId: w.runbook, wrongDocumentId: w.billing, spaceId: w.other, statement: 'Billing has a new dashboard.' });
  });

  test('an edit that lands just before undo applies is reported, not overwritten', async () => {
    const w = await world();
    const id = await capture(w, 'Billing moved to Adyen. Invoices now go out weekly.');
    const changes = await changesOf(w.tenant.id, id);
    const billingChange = changes.find((c) => c.afterMarkdown.includes('Adyen'))!;
    const invoiceChange = changes.find((c) => c.afterMarkdown.includes('weekly'))!;
    let raced = false;
    const racing: CollabClient = {
      flush: (n) => collab.flush(n),
      replaceBlocks: (a) => collab.replaceBlocks(a),
      setTitle: (a) => collab.setTitle(a),
      setFields: (a) => collab.setFields(a),
      revoke: (t) => collab.revoke(t),
      async applyBlockOps(a) {
        if (!raced) {
          raced = true;
          await collab.applyBlockOps({
            tenantId: a.tenantId,
            pageId: a.pageId,
            actor: { type: 'user', id: w.owner.userId },
            source: 'human',
            ops: [{ op: 'replace', blockId: billingChange.blockId, blocks: [{ id: 'y', type: 'paragraph', props: {}, content: [{ type: 'text', text: 'Billing uses Adyen and PayPal.', styles: {} }], children: [] }] }],
          });
        }
        return collab.applyBlockOps(a);
      },
    };
    const racingApp = buildTestApp({ collab: racing, embeddingProvider: embedder });
    const res = await racingApp.inject({ method: 'POST', url: `/api/v1/captures/${id}/undo`, headers: w.headers });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ undone: [invoiceChange.id], changedSince: [billingChange.id] });
    expect(await live(w.tenant.id, w.billing)).toEqual(['Billing uses Adyen and PayPal.', 'Invoices go out monthly.']);
    await racingApp.close();
  });

  test('move takes every block the fact added on that page', async () => {
    const w = await world();
    const id = await capture(w, 'Billing has a new dashboard.');
    const [first] = await changesOf(w.tenant.id, id);
    // The same fact also added a second block right after the first.
    await collab.applyBlockOps({
      tenantId: w.tenant.id,
      pageId: w.billing,
      actor: { type: 'user', id: w.owner.userId },
      source: 'human',
      ops: [{ op: 'insert_after', after: first!.blockId, blocks: [{ id: 'second-block', type: 'paragraph', props: {}, content: [{ type: 'text', text: 'It shows revenue.', styles: {} }], children: [] }] }],
    });
    await withTenantTx(w.tenant.id, (tx) =>
      tx.insert(captureChanges).values({
        tenantId: w.tenant.id, captureId: id, factId: first!.factId, documentId: w.billing, spaceId: first!.spaceId,
        blockId: 'second-block', op: 'insert', afterMarkdown: 'It shows revenue.',
      })
    );
    const res = await post(w.headers, `/api/v1/capture-changes/${first!.id}/move`, { target_page_id: w.runbook });
    expect(res.statusCode, res.body).toBe(200);
    expect(await live(w.tenant.id, w.billing)).toEqual(['Billing uses Stripe.', 'Invoices go out monthly.']);
    const statuses = (await changesOf(w.tenant.id, id)).filter((c) => c.documentId === w.billing).map((c) => c.status);
    expect(statuses).toEqual(['moved', 'moved']);
  });

  test('a sender who can no longer edit the page cannot undo there', async () => {
    const w = await world();
    const member = await signUpMember(app, w.tenant.id, 'member');
    await post(w.headers, `/api/v1/spaces/${w.space}/grants`, { principal_type: 'user', principal_id: member.userId, role: 'editor' });
    const res = await post(member.headers, '/api/v1/captures', { text: 'Billing moved to Adyen.', scope_page_id: w.billing });
    expect(res.statusCode, res.body).toBe(201);
    await run(w.tenant.id);
    const [change] = await changesOf(w.tenant.id, res.json().id);
    await post(w.headers, `/api/v1/spaces/${w.space}/grants`, { principal_type: 'user', principal_id: member.userId, role: 'viewer' });
    const undo = await post(member.headers, `/api/v1/capture-changes/${change!.id}/undo`);
    expect(undo.statusCode).toBe(404);
    expect(await live(w.tenant.id, w.billing)).toContain('Billing moved to Adyen.');
  });

  test('placing a needs-home fact applies it to the chosen page', async () => {
    const w = await world();
    const id = await capture(w, 'Lunch is at noon.');
    const [fact] = await factsOf(w.tenant.id, id);
    expect(fact!.outcome).toBe('needs_home');
    const list = await get(w.headers, '/api/v1/needs-home');
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json()).toMatchObject([{ factId: fact!.id, statement: 'Lunch is at noon.', captureId: id }]);

    const res = await post(w.headers, `/api/v1/capture-facts/${fact!.id}/place`, { document_id: w.runbook });
    expect(res.statusCode, res.body).toBe(200);
    await run(w.tenant.id);
    expect(await live(w.tenant.id, w.runbook)).toEqual(['Page the on-call.', 'Lunch is at noon.']);
    expect((await factsOf(w.tenant.id, id))[0]).toMatchObject({ outcome: 'applied' });
    expect((await withTenantTx(w.tenant.id, (tx) => tx.select().from(routingExamples)))[0]).toMatchObject({
      chosenDocumentId: w.runbook,
      wrongDocumentId: null,
    });
    expect((await get(w.headers, '/api/v1/needs-home')).json()).toEqual([]);
  });

  test('dismissing a needs-home fact takes it off the list', async () => {
    const w = await world();
    const id = await capture(w, 'Lunch is at noon.');
    const [fact] = await factsOf(w.tenant.id, id);
    const res = await post(w.headers, `/api/v1/capture-facts/${fact!.id}/dismiss`);
    expect(res.statusCode, res.body).toBe(200);
    expect((await factsOf(w.tenant.id, id))[0]!.outcome).toBe('dismissed');
    expect((await get(w.headers, '/api/v1/needs-home')).json()).toEqual([]);
    expect((await post(w.headers, `/api/v1/capture-facts/${fact!.id}/dismiss`)).statusCode).toBe(409);
  });
});
