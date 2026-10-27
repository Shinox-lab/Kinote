import { describe, test, beforeAll, afterEach, afterAll, expect } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { withTenantTx, captureFacts, documents, routingExamples, spaceGrants } from '@living-wiki/db';
import { DeterministicEmbeddingProvider, DeterministicPlacementModel, blockText } from '@living-wiki/core';
import type { BlockLike } from '@living-wiki/shared';
import { collabSettle, type CollabServer } from '../../collab/src/server.js';
import { startCollabServer } from '../../collab/test/support/wsClient.js';
import { readBlocks } from '../../collab/test/support/blocks.js';
import { storedDoc } from '../../collab/test/support/collabWorld.js';
import { runPendingJobsForTenant } from '../../worker/src/runner.js';
import { InProcessCollabClient } from './support/inProcessCollab.js';
import { bootstrapTenant, buildTestApp, signUpMember, useTestDb } from './support/testkit.js';

type Headers = Record<string, string>;

const NOTE = 'Oct 14 meeting with George\n- George hero video swap.\n- Shop the look.\n- George launch moved to December.';
const TITLE = 'Oct 14 meeting with George';

describe('document captures', () => {
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
  const run = (tenantId: string) =>
    runPendingJobsForTenant(tenantId, { collab, placementModel: model, embeddingProvider: embedder });

  async function world(opts: { withClient?: boolean } = { withClient: true }) {
    const { tenant, owner, headers } = await bootstrapTenant(app, { name: 'Docs Co', slug: 'docs-co' });
    const clients = (await post(headers, '/api/v1/spaces', { name: 'Clients', slug: 'clients' })).json().id as string;
    const page = async (title: string, slug: string, markdown: string, parentId: string | null = null) => {
      const res = await post(headers, '/api/v1/pages', { space_id: clients, parent_id: parentId, title, slug, markdown });
      expect(res.statusCode, res.body).toBe(201);
      const id = res.json().id as string;
      // Indexed, so routing can find it (cards and entities come from indexed versions).
      const snap = await post(headers, `/api/v1/pages/${id}/snapshot`);
      expect(snap.statusCode, snap.body).toBeLessThan(300);
      await run(tenant.id);
      return id;
    };
    let george: string | null = null;
    if (opts.withClient) {
      george = await page('Client - George', 'george', 'George is a client. Launch is in November.');
      await page('Meeting 1', 'meeting-1', 'First meeting agenda.', george);
      await page('29Sep', 'sep-29', 'Hero video notes.', george);
    }
    const lunch = await page('Lunch menu', 'lunch', 'Soup on Monday.');
    await run(tenant.id);
    return { tenant, owner, headers, clients, george, lunch, page };
  }

  async function capture(w: Awaited<ReturnType<typeof world>>, text = NOTE, headers = w.headers, extra: object = {}) {
    const res = await post(headers, '/api/v1/captures', { text, ...extra });
    expect(res.statusCode, res.body).toBe(201);
    await run(w.tenant.id);
    return res.json().id as string;
  }

  const receiptOf = async (headers: Headers, id: string) => {
    const res = await get(headers, `/api/v1/captures/${id}`);
    expect(res.statusCode, res.body).toBe(200);
    return res.json();
  };
  const pageTitled = async (tenantId: string, title: string) =>
    (await withTenantTx(tenantId, (tx) => tx.select().from(documents).where(eq(documents.title, title))))[0];
  const live = async (tenantId: string, pageId: string) =>
    (readBlocks(await storedDoc(tenantId, pageId)) as BlockLike[]).map(blockText);

  test('the receipt leads with the new page and lists facts kept on it', async () => {
    const w = await world();
    const id = await capture(w);
    const detail = await receiptOf(w.headers, id);
    expect(detail.capture).toMatchObject({ shapeMode: 'auto', shape: 'document' });
    const page = await pageTitled(w.tenant.id, TITLE);
    expect(detail.receipt.document).toMatchObject({
      pageId: page!.id,
      title: TITLE,
      outcome: 'created',
      parentTitle: 'Client - George',
      spaceName: 'Clients',
      reason: null,
    });
    expect(detail.receipt.document.changeIds.length).toBeGreaterThan(0);
    const listed = detail.receipt.spaces.flatMap((s: { pages: Array<{ documentId: string }> }) => s.pages.map((p) => p.documentId));
    expect(listed).not.toContain(page!.id);
    expect(listed).toContain(w.george);
    expect(detail.receipt.filedInDocument.map((f: { statement: string }) => f.statement)).toContain('Shop the look.');
  });

  test("a sender who can no longer read the page's space sees it only as hidden", async () => {
    const w = await world();
    const member = await signUpMember(app, w.tenant.id, 'member');
    await post(w.headers, `/api/v1/spaces/${w.clients}/grants`, { principal_type: 'user', principal_id: member.userId, role: 'editor' });
    const id = await capture(w, NOTE, member.headers);
    await withTenantTx(w.tenant.id, (tx) => tx.delete(spaceGrants).where(eq(spaceGrants.principalId, member.userId)));
    const { receipt } = await receiptOf(member.headers, id);
    expect(receipt.document).toBeNull();
    expect(receipt.hiddenChanges).toBeGreaterThan(0);
  });

  test('shape is stored from the request', async () => {
    const w = await world();
    const res = await post(w.headers, '/api/v1/captures', { text: NOTE, shape: 'updates' });
    expect(res.json()).toMatchObject({ shapeMode: 'updates', shape: null });
  });

  test('Needs a home lists a waiting document with its options; placing it creates the page', async () => {
    const w = await world({ withClient: false });
    const id = await capture(w);
    const list = await get(w.headers, '/api/v1/needs-home/documents');
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json()).toEqual([expect.objectContaining({ captureId: id, title: TITLE, subject: 'George' })]);
    expect((await receiptOf(w.headers, id)).receipt.document).toMatchObject({ outcome: 'needs_home', pageId: null });

    const placed = await post(w.headers, `/api/v1/captures/${id}/document/place`, { parent_page_id: w.lunch, title: '14Oct' });
    expect(placed.statusCode, placed.body).toBe(200);
    await run(w.tenant.id);
    const { receipt } = await receiptOf(w.headers, id);
    expect(receipt.document).toMatchObject({ outcome: 'created', title: '14Oct', parentTitle: 'Lunch menu' });
    expect((await get(w.headers, '/api/v1/needs-home/documents')).json()).toEqual([]);
    const examples = await withTenantTx(w.tenant.id, (tx) => tx.select().from(routingExamples));
    expect(examples).toEqual([expect.objectContaining({ kind: 'document', chosenDocumentId: w.lunch, statement: 'George 14Oct' })]);

    const again = await post(w.headers, `/api/v1/captures/${id}/document/place`, { parent_page_id: w.lunch });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe('document_not_waiting');
  });

  test('route as updates files the facts without a page', async () => {
    const w = await world({ withClient: false });
    const id = await capture(w);
    const res = await post(w.headers, `/api/v1/captures/${id}/document/as-updates`);
    expect(res.statusCode, res.body).toBe(200);
    await run(w.tenant.id);
    expect(await pageTitled(w.tenant.id, TITLE)).toBeUndefined();
    const { receipt, capture: summary } = await receiptOf(w.headers, id);
    expect(summary.shape).toBe('updates');
    expect(receipt.document).toBeNull();
    const facts = await withTenantTx(w.tenant.id, (tx) => tx.select().from(captureFacts).where(eq(captureFacts.captureId, id)));
    expect(facts.some((f) => f.outcome === 'pending')).toBe(false);
  });

  test('move puts the page under another parent and saves a document example', async () => {
    const w = await world();
    const id = await capture(w);
    const archive = await w.page('Archive', 'archive', 'Old things.');
    const res = await post(w.headers, `/api/v1/captures/${id}/document/move`, { parent_page_id: archive });
    expect(res.statusCode, res.body).toBe(200);
    const page = await pageTitled(w.tenant.id, TITLE);
    expect(page!.parentId).toBe(archive);
    const [example] = await withTenantTx(w.tenant.id, (tx) => tx.select().from(routingExamples).where(eq(routingExamples.kind, 'document')));
    expect(example).toMatchObject({ chosenDocumentId: archive, wrongDocumentId: w.george });
  });

  test('undo all archives the new page and reverses standing edits', async () => {
    const w = await world();
    const id = await capture(w);
    expect(await live(w.tenant.id, w.george!)).toContain('George launch moved to December.');
    const res = await post(w.headers, `/api/v1/captures/${id}/undo`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().changedSince).toEqual([]);
    expect((await pageTitled(w.tenant.id, TITLE))!.archivedAt).not.toBeNull();
    expect(await live(w.tenant.id, w.george!)).toEqual(['George is a client. Launch is in November.']);
  });

  test('undo all leaves the new page alone after a person edited it', async () => {
    const w = await world();
    const id = await capture(w);
    const page = await pageTitled(w.tenant.id, TITLE);
    const { receipt } = await receiptOf(w.headers, id);
    const blocks = readBlocks(await storedDoc(w.tenant.id, page!.id)) as BlockLike[];
    const shop = blocks.find((b) => blockText(b) === 'Shop the look.')!;
    await collab.applyBlockOps({
      tenantId: w.tenant.id,
      pageId: page!.id,
      actor: { type: 'user', id: w.owner.userId },
      source: 'human',
      ops: [
        {
          op: 'replace',
          blockId: shop.id,
          blocks: [{ id: 'x', type: 'paragraph', props: {}, content: [{ type: 'text', text: 'Shop the look, both pages.', styles: {} }], children: [] }],
        },
      ],
    });
    const res = await post(w.headers, `/api/v1/captures/${id}/undo`);
    expect(res.statusCode, res.body).toBe(200);
    expect([...res.json().changedSince].sort()).toEqual([...receipt.document.changeIds].sort());
    const after = await withTenantTx(w.tenant.id, (tx) =>
      tx.select().from(documents).where(and(eq(documents.tenantId, w.tenant.id), eq(documents.id, page!.id)))
    );
    expect(after[0]!.archivedAt).toBeNull();
    expect(await live(w.tenant.id, w.george!)).toEqual(['George is a client. Launch is in November.']);
  });

  test('undo all leaves the new page alone after a person added to it', async () => {
    const w = await world();
    const id = await capture(w);
    const page = await pageTitled(w.tenant.id, TITLE);
    const { receipt } = await receiptOf(w.headers, id);
    const blocks = readBlocks(await storedDoc(w.tenant.id, page!.id)) as BlockLike[];
    await collab.applyBlockOps({
      tenantId: w.tenant.id,
      pageId: page!.id,
      actor: { type: 'user', id: w.owner.userId },
      source: 'human',
      ops: [
        {
          op: 'insert_after',
          after: blocks.at(-1)!.id,
          blocks: [{ id: 'mine', type: 'paragraph', props: {}, content: [{ type: 'text', text: 'Follow-ups from me.', styles: {} }], children: [] }],
        },
      ],
    });
    const res = await post(w.headers, `/api/v1/captures/${id}/undo`);
    expect(res.statusCode, res.body).toBe(200);
    expect([...res.json().changedSince].sort()).toEqual([...receipt.document.changeIds].sort());
    expect((await pageTitled(w.tenant.id, TITLE))!.archivedAt).toBeNull();
  });
});

