import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { and, eq } from 'drizzle-orm';
import { captureChanges, captureFacts, documents, pageFieldValues, pages, suggestions, versions, withTenantTx } from '@kinote/db';
import { routeCapture, type PlannedEdit, type RoutingModel } from '@kinote/core';
import { FIELDS_MAP } from '@kinote/contracts';
import { collabSettle, type CollabServer } from '../../collab/src/server.js';
import { startCollabServer } from '../../collab/test/support/wsClient.js';
import { InProcessCollabClient } from '../../api/test/support/inProcessCollab.js';
import { useTestDb } from '../../api/test/support/testkit.js';
import {
  addCapture,
  addCollection,
  addRoutingSpace,
  embedder,
  liveBlockId,
  livePage,
  model,
  routingWorld,
  setLiveFields,
} from '../../../packages/core/test/fixtures/routingSeed.js';

describe('routing field changes', () => {
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

  const route = (tenantId: string, captureId: string, opts: { m?: RoutingModel; afterPlan?: () => Promise<void> } = {}) =>
    routeCapture({ tenantId, captureId, holder: 'test' }, { model: opts.m ?? model, embedder, collab, hooks: { afterPlan: opts.afterPlan } });
  const fixed = (edits: PlannedEdit[]): RoutingModel => Object.assign(Object.create(model), { async planEdits() { return { edits }; } });

  async function liveFields(tenantId: string, pageId: string) {
    const [row] = await withTenantTx(tenantId, (tx) => tx.select().from(pages).where(and(eq(pages.tenantId, tenantId), eq(pages.documentId, pageId))));
    const doc = new Y.Doc();
    Y.applyUpdate(doc, new Uint8Array(row!.ydocState));
    return doc.getMap(FIELDS_MAP).toJSON();
  }
  const versionsOf = (tenantId: string, pageId: string) =>
    withTenantTx(tenantId, (tx) => tx.select().from(versions).where(and(eq(versions.tenantId, tenantId), eq(versions.documentId, pageId))));

  async function clientsWorld(opts: { reviewRequired?: boolean } = {}) {
    const w = await routingWorld();
    const space = await addRoutingSpace(w, { name: 'Clients', reviewRequired: opts.reviewRequired });
    const clients = await livePage(w, space, 'Clients', 'Our clients.');
    const [status, launch] = await addCollection(w, clients.documentId, [
      { name: 'Status', type: 'select', choices: ['Lead', 'Active', 'Churned'] },
      { name: 'Launch date', type: 'date' },
    ]);
    const george = await livePage(w, space, 'George', 'George is a retail client.', { parentId: clients.documentId });
    await setLiveFields(w, george.documentId, { [status!.id]: 'status:lead', [launch!.id]: { start: '2026-11-15' } });
    return { w, space, clients, george, status: status!, launch: launch! };
  }

  it('applies a field change live, with a receipt row and one snapshot', async () => {
    const c = await clientsWorld();
    const captureId = await addCapture(c.w, c.w.userId, 'George launch date moved to 2026-12-01.');
    expect(await route(c.w.tenantId, captureId)).toBe('done');
    expect((await liveFields(c.w.tenantId, c.george.documentId))[c.launch.id]).toEqual({ start: '2026-12-01' });
    const changes = await withTenantTx(c.w.tenantId, (tx) => tx.select().from(captureChanges));
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      op: 'set_field',
      blockId: `field:${c.launch.id}`,
      beforeMarkdown: '{"start":"2026-11-15"}',
      afterMarkdown: '{"start":"2026-12-01"}',
      status: 'applied',
    });
    expect(changes[0]!.versionId).not.toBeNull();
    const [version] = await withTenantTx(c.w.tenantId, (tx) => tx.select().from(versions).where(eq(versions.id, changes[0]!.versionId!)));
    expect((version!.fields as Record<string, unknown>)[c.launch.id]).toEqual({ start: '2026-12-01' });
    const [fact] = await withTenantTx(c.w.tenantId, (tx) => tx.select().from(captureFacts));
    expect(fact!.outcome).toBe('applied');
  });

  it('in a review space the field change waits for review', async () => {
    const c = await clientsWorld({ reviewRequired: true });
    const captureId = await addCapture(c.w, c.w.userId, 'George launch date moved to 2026-12-01.');
    await route(c.w.tenantId, captureId);
    const [change] = await withTenantTx(c.w.tenantId, (tx) => tx.select().from(captureChanges));
    const [version] = await withTenantTx(c.w.tenantId, (tx) => tx.select().from(versions).where(eq(versions.id, change!.versionId!)));
    expect(version!.status).toBe('pending_review');
    const [fact] = await withTenantTx(c.w.tenantId, (tx) => tx.select().from(captureFacts));
    expect(fact!.outcome).toBe('waiting_review');
  });

  it('a text edit and a field edit on one page are one collab change and one snapshot', async () => {
    const c = await clientsWorld();
    const block = await liveBlockId(c.w, c.george.documentId, 'George is a retail client');
    const before = (await versionsOf(c.w.tenantId, c.george.documentId)).length;
    const both = fixed([
      { op: { op: 'replace', documentId: c.george.documentId, blockId: block, markdown: 'George is an active retail client.' }, confidence: 0.9, reason: 'r' },
      { op: { op: 'set_field', documentId: c.george.documentId, fieldId: c.status.id, value: 'Active' }, confidence: 0.9, reason: 'r' },
    ]);
    await route(c.w.tenantId, await addCapture(c.w, c.w.userId, 'George is now active.'), { m: both });
    expect((await versionsOf(c.w.tenantId, c.george.documentId)).length).toBe(before + 1);
    expect((await liveFields(c.w.tenantId, c.george.documentId))[c.status.id]).toBe('status:active');
    const changes = await withTenantTx(c.w.tenantId, (tx) => tx.select().from(captureChanges));
    expect(changes.map((x) => x.op).sort()).toEqual(['replace', 'set_field']);
    expect(new Set(changes.map((x) => x.versionId)).size).toBe(1);
  });

  it('a person changing the field after planning turns the edit into a suggestion', async () => {
    const c = await clientsWorld();
    const captureId = await addCapture(c.w, c.w.userId, 'George launch date moved to 2026-12-01.');
    await route(c.w.tenantId, captureId, {
      async afterPlan() {
        await collab.setFields({
          tenantId: c.w.tenantId,
          pageId: c.george.documentId,
          values: { [c.launch.id]: { start: '2027-01-10' } },
          actor: { type: 'user', id: c.w.userId },
          source: 'human',
        });
      },
    });
    expect((await liveFields(c.w.tenantId, c.george.documentId))[c.launch.id]).toEqual({ start: '2027-01-10' });
    const [s] = await withTenantTx(c.w.tenantId, (tx) => tx.select().from(suggestions));
    expect(s).toMatchObject({ kind: 'set_field', blockId: `field:${c.launch.id}`, blockedBy: 'protection' });
    expect(await withTenantTx(c.w.tenantId, (tx) => tx.select().from(captureChanges))).toEqual([]);
  });

  it('a clear becomes a set_field suggestion with expected and proposed values', async () => {
    const c = await clientsWorld();
    await route(c.w.tenantId, await addCapture(c.w, c.w.userId, 'George no longer has a launch date.'));
    const [s] = await withTenantTx(c.w.tenantId, (tx) => tx.select().from(suggestions));
    expect(s).toMatchObject({
      kind: 'set_field',
      blockId: `field:${c.launch.id}`,
      blockedBy: 'removal',
      proposedMarkdown: 'null',
      proposedBlocks: null,
      expectedText: '{"start":"2026-11-15"}',
    });
    expect((await liveFields(c.w.tenantId, c.george.documentId))[c.launch.id]).toEqual({ start: '2026-11-15' });
  });

  it('a new page under a collection gets its planned fields with receipt rows', async () => {
    const c = await clientsWorld();
    const creating = fixed([
      {
        op: {
          op: 'create_page',
          spaceId: c.space,
          parentId: c.clients.documentId,
          title: 'Hana',
          markdown: 'Hana is a new client.',
          fields: [{ fieldId: c.status.id, value: 'Active' }],
        },
        confidence: 0.9,
        reason: 'A new client.',
      },
    ]);
    await route(c.w.tenantId, await addCapture(c.w, c.w.userId, 'Hana is a new client.'), { m: creating });
    const [hana] = await withTenantTx(c.w.tenantId, (tx) =>
      tx.select().from(documents).where(and(eq(documents.tenantId, c.w.tenantId), eq(documents.title, 'Hana')))
    );
    expect(await liveFields(c.w.tenantId, hana!.id)).toEqual({ [c.status.id]: 'status:active' });
    const changes = await withTenantTx(c.w.tenantId, (tx) => tx.select().from(captureChanges).where(eq(captureChanges.documentId, hana!.id)));
    expect(changes.find((x) => x.op === 'set_field')).toMatchObject({
      blockId: `field:${c.status.id}`,
      beforeMarkdown: null,
      afterMarkdown: '"status:active"',
    });
    const [version] = await versionsOf(c.w.tenantId, hana!.id);
    expect(version!.fields).toEqual({ [c.status.id]: 'status:active' });
    // Collection views read the projection: it holds the new page's values at once.
    const projected = await withTenantTx(c.w.tenantId, (tx) => tx.select().from(pageFieldValues).where(eq(pageFieldValues.pageId, hana!.id)));
    expect(projected.map((r) => [r.fieldId, r.value])).toEqual([[c.status.id, 'status:active']]);
  });

  it('a document capture filed under a collection can set its own page fields', async () => {
    const c = await clientsWorld();
    await livePage(c.w, c.space, 'Meeting 1', 'First meeting agenda.', { parentId: c.clients.documentId });
    const note = 'Kickoff with Hana\n- Hana kickoff went well.\n- Kickoff with Hana status is now Active.\n- Notes were taken.';
    await route(c.w.tenantId, await addCapture(c.w, c.w.userId, note));
    const [page] = await withTenantTx(c.w.tenantId, (tx) =>
      tx.select().from(documents).where(and(eq(documents.tenantId, c.w.tenantId), eq(documents.title, 'Kickoff with Hana')))
    );
    expect(page!.parentId).toBe(c.clients.documentId);
    expect((await liveFields(c.w.tenantId, page!.id))[c.status.id]).toBe('status:active');
    const [change] = await withTenantTx(c.w.tenantId, (tx) => tx.select().from(captureChanges).where(eq(captureChanges.op, 'set_field')));
    expect(change).toMatchObject({ documentId: page!.id, blockId: `field:${c.status.id}`, status: 'applied' });
    expect(change!.factId).not.toBeNull();
  });
});
