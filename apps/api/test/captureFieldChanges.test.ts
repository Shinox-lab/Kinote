import { describe, test, beforeAll, afterEach, afterAll, expect } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { withTenantTx, blockActivity, captureChanges, captureFacts, documents, suggestions, versions } from '@kinote/db';
import { DeterministicEmbeddingProvider, DeterministicPlacementModel, type PlannedEdit, type RoutingModel } from '@kinote/core';
import { FIELDS_MAP } from '@kinote/contracts';
import { collabSettle, type CollabServer } from '../../collab/src/server.js';
import { startCollabServer } from '../../collab/test/support/wsClient.js';
import { readBlocks } from '../../collab/test/support/blocks.js';
import { storedDoc } from '../../collab/test/support/collabWorld.js';
import { runPendingJobsForTenant } from '../../worker/src/runner.js';
import { InProcessCollabClient } from './support/inProcessCollab.js';
import { bootstrapTenant, buildTestApp, useTestDb } from './support/testkit.js';

type Headers = Record<string, string>;

/** Undo, accept and receipts of routed field changes (C10). */
describe('routed field changes: undo, accept, receipts', () => {
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

  const req = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', headers: Headers, url: string, payload?: unknown) =>
    app.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as any } : {}) });
  const run = (tenantId: string, m: RoutingModel = model) =>
    runPendingJobsForTenant(tenantId, { collab, placementModel: m, embeddingProvider: embedder });

  async function world() {
    const { tenant, owner, headers } = await bootstrapTenant(app, { name: 'Field Undo Co', slug: 'field-undo-co' });
    const space = (await req('POST', headers, '/api/v1/spaces', { name: 'Clients', slug: 'clients' })).json().id as string;
    const other = (await req('POST', headers, '/api/v1/spaces', { name: 'Notes', slug: 'notes' })).json().id as string;
    const page = async (spaceId: string, title: string, slug: string, markdown: string, parentId: string | null = null) => {
      const res = await req('POST', headers, '/api/v1/pages', { space_id: spaceId, parent_id: parentId, title, slug, markdown });
      expect(res.statusCode, res.body).toBe(201);
      return res.json().id as string;
    };
    const clients = await page(space, 'Clients', 'clients', 'Our clients.');
    expect((await req('POST', headers, `/api/v1/pages/${clients}/collection`)).statusCode).toBe(201);
    const field = async (body: unknown) => {
      const res = await req('POST', headers, `/api/v1/collections/${clients}/fields`, body);
      expect(res.statusCode, res.body).toBe(201);
      return res.json() as { id: string; options: { choices?: Array<{ id: string; name: string }> } };
    };
    const status = await field({
      name: 'Status',
      type: 'select',
      options: { choices: ['Lead', 'Active', 'Churned'].map((name) => ({ id: name.toLowerCase(), name, color: 'gray' })) },
    });
    const launch = await field({ name: 'Launch date', type: 'date' });
    const tier = await field({ name: 'Tier', type: 'text' });
    const george = await page(space, 'George', 'george', 'George is a retail client.', clients);
    const notes = await page(other, 'Notes', 'notes-page', 'Loose notes.');
    const setFields = async (pageId: string, values: Record<string, unknown>) => {
      const res = await req('PATCH', headers, `/api/v1/pages/${pageId}/fields`, values);
      expect(res.statusCode, res.body).toBeLessThan(300);
    };
    await setFields(george, { [status.id]: 'lead', [launch.id]: { start: '2026-11-15' } });
    await run(tenant.id);
    // The setup's own edits are old news: outside the protection window.
    await collabSettle(server);
    await withTenantTx(tenant.id, (tx) => tx.update(blockActivity).set({ changedAt: new Date(Date.now() - 86_400_000) }).where(eq(blockActivity.tenantId, tenant.id)));
    return { tenant, owner, headers, space, other, clients, george, notes, status, launch, tier, setFields };
  }
  type W = Awaited<ReturnType<typeof world>>;

  async function capture(w: W, text: string, opts: { pageId?: string | null; m?: RoutingModel } = {}) {
    const pageId = opts.pageId === undefined ? w.george : opts.pageId;
    const res = await req('POST', w.headers, '/api/v1/captures', { text, ...(pageId ? { scope_page_id: pageId } : {}) });
    expect(res.statusCode, res.body).toBe(201);
    await run(w.tenant.id, opts.m);
    return res.json().id as string;
  }
  const fieldsOf = async (w: W, pageId: string) => (await storedDoc(w.tenant.id, pageId)).getMap(FIELDS_MAP).toJSON();
  const changesOf = (w: W, captureId: string) =>
    withTenantTx(w.tenant.id, (tx) => tx.select().from(captureChanges).where(eq(captureChanges.captureId, captureId)).orderBy(captureChanges.createdAt));
  const fieldChange = async (w: W, captureId: string) => (await changesOf(w, captureId)).find((c) => c.op === 'set_field')!;
  const suggestionsOf = (w: W, captureId: string) =>
    withTenantTx(w.tenant.id, (tx) => tx.select().from(suggestions).where(eq(suggestions.captureId, captureId)));
  const personTouched = (w: W, fieldId: string) =>
    withTenantTx(w.tenant.id, async (tx) => {
      await tx.delete(blockActivity).where(and(eq(blockActivity.pageId, w.george), eq(blockActivity.blockId, `field:${fieldId}`)));
      await tx.insert(blockActivity).values({
        tenantId: w.tenant.id, pageId: w.george, blockId: `field:${fieldId}`, actorType: 'user', actorId: w.owner.userId,
        changedAt: new Date(Date.now() - 60_000),
      });
    });

  test('undo restores the before value', async () => {
    const w = await world();
    const id = await capture(w, 'George launch date moved to 2026-12-01.');
    expect((await fieldsOf(w, w.george))[w.launch.id]).toEqual({ start: '2026-12-01' });
    const change = await fieldChange(w, id);
    const res = await req('POST', w.headers, `/api/v1/capture-changes/${change.id}/undo`);
    expect(res.json()).toEqual({ undone: [change.id], changedSince: [] });
    expect((await fieldsOf(w, w.george))[w.launch.id]).toEqual({ start: '2026-11-15' });
    expect((await changesOf(w, id))[0]!.status).toBe('undone');
    const [fact] = await withTenantTx(w.tenant.id, (tx) => tx.select().from(captureFacts).where(eq(captureFacts.captureId, id)));
    expect(fact!.outcome).toBe('undone');
  });

  test('undo of a field set on an empty field clears it', async () => {
    const w = await world();
    const id = await capture(w, 'George tier is now Gold.');
    expect((await fieldsOf(w, w.george))[w.tier.id]).toBe('Gold');
    const change = await fieldChange(w, id);
    expect(change.beforeMarkdown).toBeNull();
    expect((await req('POST', w.headers, `/api/v1/capture-changes/${change.id}/undo`)).json()).toEqual({ undone: [change.id], changedSince: [] });
    expect(w.tier.id in (await fieldsOf(w, w.george))).toBe(false);
  });

  test('undo leaves a field a person changed since and reports it', async () => {
    const w = await world();
    const id = await capture(w, 'George launch date moved to 2026-12-01.');
    await w.setFields(w.george, { [w.launch.id]: { start: '2027-02-01' } });
    const change = await fieldChange(w, id);
    expect((await req('POST', w.headers, `/api/v1/capture-changes/${change.id}/undo`)).json()).toEqual({ undone: [], changedSince: [change.id] });
    expect((await fieldsOf(w, w.george))[w.launch.id]).toEqual({ start: '2027-02-01' });
  });

  test('undo reports a change whose field was removed', async () => {
    const w = await world();
    const id = await capture(w, 'George launch date moved to 2026-12-01.');
    expect((await req('DELETE', w.headers, `/api/v1/collections/${w.clients}/fields/${w.launch.id}`)).statusCode).toBeLessThan(300);
    const change = await fieldChange(w, id);
    expect((await req('POST', w.headers, `/api/v1/capture-changes/${change.id}/undo`)).json()).toEqual({ undone: [], changedSince: [change.id] });
  });

  test('accepting a set_field suggestion applies it and snapshots', async () => {
    const w = await world();
    const id = await capture(w, 'George no longer has a launch date.');
    const [s] = await suggestionsOf(w, id);
    expect(s).toMatchObject({ kind: 'set_field', blockedBy: 'removal' });
    const before = await withTenantTx(w.tenant.id, (tx) => tx.select().from(versions).where(eq(versions.documentId, w.george)));
    const res = await req('POST', w.headers, `/api/v1/suggestions/${s!.id}/accept`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ kind: 'set_field', status: 'accepted', field: { name: 'Launch date', before: '2026-11-15 (15 November 2026)', after: null } });
    expect(w.launch.id in (await fieldsOf(w, w.george))).toBe(false);
    const after = await withTenantTx(w.tenant.id, (tx) => tx.select().from(versions).where(eq(versions.documentId, w.george)));
    expect(after.length).toBe(before.length + 1);
  });

  test('accepting goes stale when the choice was removed', async () => {
    const w = await world();
    await personTouched(w, w.status.id);
    const id = await capture(w, 'George status is now Active.');
    const [s] = await suggestionsOf(w, id);
    expect(s).toMatchObject({ kind: 'set_field', blockedBy: 'protection', proposedMarkdown: '"active"' });
    expect((await req('PATCH', w.headers, `/api/v1/collections/${w.clients}/fields/${w.status.id}`, { remove_choice: 'active' })).statusCode).toBe(200);
    const res = await req('POST', w.headers, `/api/v1/suggestions/${s!.id}/accept`);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'suggestion_not_open' });
    const [after] = await suggestionsOf(w, id);
    expect(after!.status).toBe('stale');
  });

  test('accepting goes stale when the value changed since it was proposed', async () => {
    const w = await world();
    await personTouched(w, w.status.id);
    const id = await capture(w, 'George status is now Active.');
    const [s] = await suggestionsOf(w, id);
    await w.setFields(w.george, { [w.status.id]: 'churned' });
    const res = await req('POST', w.headers, `/api/v1/suggestions/${s!.id}/accept`);
    expect(res.statusCode).toBe(409);
    expect((await suggestionsOf(w, id))[0]!.status).toBe('stale');
    expect((await fieldsOf(w, w.george))[w.status.id]).toBe('churned');
  });

  test('the receipt shows "Launch date" with before and after text', async () => {
    const w = await world();
    const id = await capture(w, 'George launch date moved to 2026-12-01.');
    const detail = (await req('GET', w.headers, `/api/v1/captures/${id}`)).json();
    const changes = detail.receipt.spaces.flatMap((s: any) => s.pages.flatMap((p: any) => p.changes));
    expect(changes).toHaveLength(1);
    expect(changes[0].field).toEqual({
      fieldId: w.launch.id,
      name: 'Launch date',
      before: '2026-11-15 (15 November 2026)',
      after: '2026-12-01 (1 December 2026)',
    });
    const listed = (await req('GET', w.headers, `/api/v1/pages/${w.george}/capture-changes?capture=${id}`)).json();
    expect(listed[0].field).toMatchObject({ name: 'Launch date' });
  });

  test('undoing a document page with field changes still archives it', async () => {
    const w = await world();
    await req('POST', w.headers, '/api/v1/pages', { space_id: w.space, parent_id: w.clients, title: 'Meeting 1', slug: 'meeting-1', markdown: 'First meeting agenda.' });
    await run(w.tenant.id);
    const note = 'Kickoff with Hana\n- Hana kickoff went well.\n- Kickoff with Hana status is now Active.\n- Notes were taken.';
    const id = await capture(w, note, { pageId: null });
    // The person files the document under the collection.
    const placed = await req('POST', w.headers, `/api/v1/captures/${id}/document/place`, { parent_page_id: w.clients });
    expect(placed.statusCode, placed.body).toBe(200);
    await run(w.tenant.id);
    const [page] = await withTenantTx(w.tenant.id, (tx) =>
      tx.select().from(documents).where(and(eq(documents.tenantId, w.tenant.id), eq(documents.title, 'Kickoff with Hana')))
    );
    expect((await fieldsOf(w, page!.id))[w.status.id]).toBe('active');
    const res = await req('POST', w.headers, `/api/v1/captures/${id}/undo`);
    expect(res.json().changedSince).toEqual([]);
    const [after] = await withTenantTx(w.tenant.id, (tx) => tx.select().from(documents).where(eq(documents.id, page!.id)));
    expect(after!.archivedAt).not.toBeNull();
    expect((await changesOf(w, id)).every((c) => c.status === 'undone')).toBe(true);
  });

  test('wrong page on a fact with a text and a field change undoes both', async () => {
    const w = await world();
    const block = (readBlocks(await storedDoc(w.tenant.id, w.george)) as Array<{ id: string }>)[0]!.id;
    const both: RoutingModel = Object.assign(Object.create(model), {
      async planEdits() {
        const edits: PlannedEdit[] = [
          { op: { op: 'replace', documentId: w.george, blockId: block, markdown: 'George is an active retail client.' }, confidence: 0.9, reason: 'r' },
          { op: { op: 'set_field', documentId: w.george, fieldId: w.status.id, value: 'Active' }, confidence: 0.9, reason: 'r' },
        ];
        return { edits };
      },
    });
    const id = await capture(w, 'George is now active.', { m: both });
    const text = (await changesOf(w, id)).find((c) => c.op === 'replace')!;
    const res = await req('POST', w.headers, `/api/v1/capture-changes/${text.id}/move`, { target_page_id: w.notes });
    expect(res.statusCode, res.body).toBe(200);
    expect((await fieldsOf(w, w.george))[w.status.id]).toBe('lead');
    expect((await changesOf(w, id)).filter((c) => c.documentId === w.george).map((c) => c.status)).toEqual(['moved', 'moved']);
  });
});
