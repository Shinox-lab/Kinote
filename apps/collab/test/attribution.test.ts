import { describe, test, beforeAll, afterEach, afterAll, expect } from 'vitest';
import * as Y from 'yjs';
import { createServerEditor } from '@living-wiki/shared';
import { and, eq, sql } from 'drizzle-orm';
import {
  withTenantTx,
  pages,
  blockActivity,
  pagePendingContributors,
  jobs,
  claimJobs,
  lockDocument,
} from '@living-wiki/db';
import { takePageSnapshot } from '@living-wiki/core';
import { changedBlockIds } from '../src/attribution.js';
import {
  collabSettle,
  flushDocument,
  openDirectSession,
  replaceDocumentBlocks,
  type CollabServer,
} from '../src/server.js';
import { connectClient, startCollabServer, type ConnectedClient } from './support/wsClient.js';
import { readBlocks, fragmentText } from './support/blocks.js';
import { editBlockText, deleteBlock } from './support/editBlock.js';
import { buildReviewWorld, waitFor } from './support/collabWorld.js';
import { buildTestApp, useTestDb } from '../../api/test/support/testkit.js';

const editor = createServerEditor();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function paragraph(id: string, text: string, children: any[] = []) {
  return { id, type: 'paragraph', content: text, children };
}

function bullet(id: string, text: string, children: any[] = []) {
  return { id, type: 'bulletListItem', content: text, children };
}

/** A page Y.Doc built by BlockNote itself, as the API and clients build them. */
function blockDoc(blocks: any[]): Y.Doc {
  return editor.blocksToYDoc(blocks as any, 'document-store');
}

/** Runs `fn` on `doc` and returns the changed block ids of every transaction it made. */
function idsOf(doc: Y.Doc, fn: () => void): string[][] {
  const seen: string[][] = [];
  const listener = (tx: Y.Transaction) => seen.push(changedBlockIds(tx));
  doc.on('afterTransaction', listener);
  try {
    fn();
  } finally {
    doc.off('afterTransaction', listener);
  }
  return seen;
}

describe('changedBlockIds', () => {
  const three = () =>
    blockDoc([paragraph('p1', 'one'), paragraph('p2', 'two'), paragraph('p3', 'three')]);

  test('editing the second of three paragraphs names only the second', () => {
    const doc = three();
    expect(idsOf(doc, () => editBlockText(doc, 'p2', ' more'))).toEqual([['p2']]);
  });

  test('deleting the third paragraph names nothing', () => {
    const doc = three();
    expect(idsOf(doc, () => deleteBlock(doc, 'p3'))).toEqual([[]]);
    expect(readBlocks(doc).map((b) => b.id)).toEqual(['p1', 'p2']);
  });

  test('editing a nested child names the child only', () => {
    const doc = blockDoc([paragraph('p1', 'one'), bullet('b1', 'parent', [bullet('c1', 'child')])]);
    expect(idsOf(doc, () => editBlockText(doc, 'c1', ' edited'))).toEqual([['c1']]);
  });

  test('deleting a nested child names its parent, not the deleted child', () => {
    const doc = blockDoc([
      bullet('b1', 'parent', [bullet('c1', 'child'), bullet('c2', 'sibling')]),
    ]);
    expect(idsOf(doc, () => deleteBlock(doc, 'c1'))).toEqual([['b1']]);
  });

  test('editing two blocks in one transaction names both, once each', () => {
    const doc = three();
    const [ids] = idsOf(doc, () =>
      doc.transact(() => {
        editBlockText(doc, 'p1', ' a');
        editBlockText(doc, 'p3', ' b');
        editBlockText(doc, 'p3', ' c');
      })
    );
    expect([...ids!].sort()).toEqual(['p1', 'p3']);
  });

  test('a block inserted in the transaction is named (with its nested children)', () => {
    const doc = three();
    const group = doc.getXmlFragment('document-store').get(0) as Y.XmlElement;
    const fresh = blockDoc([bullet('n1', 'new', [bullet('n2', 'new child')])]);
    const freshGroup = fresh.getXmlFragment('document-store').get(0) as Y.XmlElement;
    const [ids] = idsOf(doc, () =>
      doc.transact(() => {
        group.insert(group.length, [(freshGroup.get(0) as Y.XmlElement).clone()]);
      })
    );
    expect([...ids!].sort()).toEqual(['n1', 'n2']);
  });

  test('a title change in meta names no block', () => {
    const doc = three();
    expect(idsOf(doc, () => doc.getMap('meta').set('title', 'Renamed'))).toEqual([[]]);
  });
});

describe('server-side block authorship', () => {
  const app = buildTestApp();
  let server: CollabServer;
  let port: number;
  const clients: ConnectedClient[] = [];

  beforeAll(async () => {
    // A long store debounce: only an explicit flush (or disconnect) stores.
    ({ server, port } = await startCollabServer(undefined, {
      debounceMs: 60_000,
      maxDebounceMs: 60_000,
    }));
  });

  useTestDb();

  afterEach(async () => {
    for (const c of clients.splice(0)) c.destroy();
    await collabSettle(server);
  });

  afterAll(async () => {
    await server.server.destroy();
  });

  async function connect(documentName: string, token: string) {
    const client = await connectClient({ port, documentName, token });
    clients.push(client);
    return client;
  }

  /** Waits until the server's live document contains `text`, then for its bookkeeping. */
  async function landed(name: string, text: string) {
    await waitFor(() => {
      const doc = server.documents.get(name);
      return !!doc && fragmentText(doc).includes(text);
    });
    await collabSettle(server);
  }

  async function activity(tenantId: string, pageId: string) {
    return withTenantTx(tenantId, (tx) =>
      tx
        .select()
        .from(blockActivity)
        .where(and(eq(blockActivity.tenantId, tenantId), eq(blockActivity.pageId, pageId)))
    );
  }

  async function pending(tenantId: string, pageId: string) {
    const rows = await withTenantTx(tenantId, (tx) =>
      tx
        .select()
        .from(pagePendingContributors)
        .where(
          and(
            eq(pagePendingContributors.tenantId, tenantId),
            eq(pagePendingContributors.pageId, pageId)
          )
        )
    );
    return rows.map((r) => `${r.principalType}:${r.principalId}`).sort();
  }

  async function pageRow(tenantId: string, pageId: string) {
    const [row] = await withTenantTx(tenantId, (tx) =>
      tx
        .select({
          liveUpdatedAt: pages.liveUpdatedAt,
          liveUpdatedAtText: sql<string>`${pages.liveUpdatedAt}::text`,
          liveChangedSinceSnapshot: pages.liveChangedSinceSnapshot,
          agentChangedAt: pages.agentChangedAt,
        })
        .from(pages)
        .where(and(eq(pages.tenantId, tenantId), eq(pages.documentId, pageId)))
    );
    return row!;
  }

  async function quietJob(tenantId: string, pageId: string) {
    const [row] = await withTenantTx(tenantId, (tx) =>
      tx
        .select()
        .from(jobs)
        .where(
          and(
            eq(jobs.tenantId, tenantId),
            eq(jobs.queue, 'page.snapshot'),
            eq(jobs.idempotencyKey, `quiet:${pageId}`)
          )
        )
    );
    return row ?? null;
  }

  async function blockIds(name: string, token: string) {
    const client = await connect(name, token);
    return { client, ids: readBlocks(client.doc).map((b) => b.id as string) };
  }

  test('A then B editing the same block: last actor B, pending contributors {A, B}', async () => {
    const w = await buildReviewWorld(app);
    const { client: ca, ids } = await blockIds(w.name, w.token('user', w.a.userId));
    const cb = await connect(w.name, w.token('user', w.b.userId));
    const first = ids[0]!;

    editBlockText(ca.doc, first, ' edited by A');
    // No settle between the two: the writes must still land in transaction order.
    await waitFor(() => fragmentText(server.documents.get(w.name)!).includes('edited by A'));
    await waitFor(() => fragmentText(cb.doc).includes('edited by A'));
    editBlockText(cb.doc, first, ' then by B');
    await landed(w.name, 'then by B');

    const rows = await activity(w.tenant.id, w.page.id);
    expect(rows.map((r) => [r.blockId, r.actorType, r.actorId])).toEqual([
      [first, 'user', w.b.userId],
    ]);
    // The owner created the page, so is pending from the start.
    expect(await pending(w.tenant.id, w.page.id)).toEqual(
      [`user:${w.owner.userId}`, `user:${w.a.userId}`, `user:${w.b.userId}`].sort()
    );
    const page = await pageRow(w.tenant.id, w.page.id);
    expect(page.liveChangedSinceSnapshot).toBe(true);
    expect(page.agentChangedAt).toBeNull();
  });

  test('a client edit of two blocks records both, attributed to the connection principal', async () => {
    const w = await buildReviewWorld(app);
    const { client, ids } = await blockIds(w.name, w.token('user', w.a.userId));
    client.doc.transact(() => {
      editBlockText(client.doc, ids[0]!, ' one');
      editBlockText(client.doc, ids[2]!, ' three');
    });
    await landed(w.name, ' three');
    const rows = await activity(w.tenant.id, w.page.id);
    expect(rows.map((r) => r.blockId).sort()).toEqual([ids[0], ids[2]].sort());
    expect(new Set(rows.map((r) => r.actorId))).toEqual(new Set([w.a.userId]));
  });

  test('a title change counts as a page change with no block ids', async () => {
    const w = await buildReviewWorld(app);
    const client = await connect(w.name, w.token('user', w.a.userId));
    const before = await pageRow(w.tenant.id, w.page.id);
    client.doc.getMap('meta').set('title', 'Renamed handbook');
    await waitFor(() => server.documents.get(w.name)?.getMap('meta').get('title') === 'Renamed handbook');
    await collabSettle(server);
    expect(await activity(w.tenant.id, w.page.id)).toEqual([]);
    expect(await pending(w.tenant.id, w.page.id)).toEqual(
      [`user:${w.owner.userId}`, `user:${w.a.userId}`].sort()
    );
    const after = await pageRow(w.tenant.id, w.page.id);
    expect(after.liveUpdatedAt.getTime()).toBeGreaterThan(before.liveUpdatedAt.getTime());
    expect(await quietJob(w.tenant.id, w.page.id)).not.toBeNull();
  });

  test('loading the document, and changes outside the page content, record nothing', async () => {
    const w = await buildReviewWorld(app);
    const before = await pageRow(w.tenant.id, w.page.id);
    const client = await connect(w.name, w.token('user', w.a.userId));
    client.doc.getMap('probe').set('k', 'not page content');
    await waitFor(() => server.documents.get(w.name)?.getMap('probe').get('k') === 'not page content');
    await sleep(200);
    await collabSettle(server);
    expect(await activity(w.tenant.id, w.page.id)).toEqual([]);
    // Only the creator, recorded when the page was created.
    expect(await pending(w.tenant.id, w.page.id)).toEqual([`user:${w.owner.userId}`]);
    expect(await quietJob(w.tenant.id, w.page.id)).toBeNull();
    expect((await pageRow(w.tenant.id, w.page.id)).liveUpdatedAtText).toBe(before.liveUpdatedAtText);
  });

  test('a read-only (viewer) client edit records nothing', async () => {
    const w = await buildReviewWorld(app);
    const before = await pageRow(w.tenant.id, w.page.id);
    const { client, ids } = await blockIds(w.name, w.token('user', w.v.userId));
    editBlockText(client.doc, ids[0]!, ' viewer typing');
    await sleep(400);
    await collabSettle(server);
    expect(fragmentText(server.documents.get(w.name)!)).not.toContain('viewer typing');
    expect(await activity(w.tenant.id, w.page.id)).toEqual([]);
    expect(await pending(w.tenant.id, w.page.id)).toEqual([`user:${w.owner.userId}`]);
    expect(await quietJob(w.tenant.id, w.page.id)).toBeNull();
    const after = await pageRow(w.tenant.id, w.page.id);
    expect(after.liveUpdatedAtText).toBe(before.liveUpdatedAtText);
    expect(after.liveChangedSinceSnapshot).toBe(before.liveChangedSinceSnapshot);
  });

  test('a direct-session agent edit marks the page agent-changed and records an agent actor', async () => {
    const w = await buildReviewWorld(app);
    const { ids } = await blockIds(w.name, w.token('user', w.a.userId));
    const session = await openDirectSession(server, {
      documentName: w.name,
      token: w.token('agent', w.agentId),
    });
    try {
      // transact resolves once its own bookkeeping has landed: no waiting here.
      await session.transact({ source: 'agent', actorId: w.agentId }, (doc) => {
        editBlockText(doc, ids[1]!, ' agent wrote this');
      });
    } finally {
      await session.close();
    }
    expect((await pageRow(w.tenant.id, w.page.id)).agentChangedAt).not.toBeNull();
    const rows = await activity(w.tenant.id, w.page.id);
    expect(rows.map((r) => [r.blockId, r.actorType, r.actorId])).toEqual([
      [ids[1], 'agent', w.agentId],
    ]);
    expect(await pending(w.tenant.id, w.page.id)).toEqual(
      [`agent:${w.agentId}`, `user:${w.owner.userId}`].sort()
    );
  });

  test('a restore leaves agent_changed_at null and records the restoring user', async () => {
    const w = await buildReviewWorld(app);
    const { ids } = await blockIds(w.name, w.token('user', w.a.userId));
    const session = await openDirectSession(server, {
      documentName: w.name,
      token: w.token('user', w.a.userId),
    });
    try {
      await session.transact({ source: 'restore', actorId: w.a.userId }, (doc) => {
        editBlockText(doc, ids[2]!, ' restored');
      });
    } finally {
      await session.close();
    }
    const page = await pageRow(w.tenant.id, w.page.id);
    expect(page.agentChangedAt).toBeNull();
    expect(page.liveChangedSinceSnapshot).toBe(true);
    const rows = await activity(w.tenant.id, w.page.id);
    expect(rows.map((r) => [r.blockId, r.actorType, r.actorId])).toEqual([
      [ids[2], 'user', w.a.userId],
    ]);
    expect(await pending(w.tenant.id, w.page.id)).toEqual(
      [`user:${w.owner.userId}`, `user:${w.a.userId}`].sort()
    );
  });

  test('replace-blocks attributes every block it writes to the named actor', async () => {
    const w = await buildReviewWorld(app);
    await replaceDocumentBlocks(server, {
      documentName: w.name,
      title: 'Replaced',
      blocks: [
        { id: 'r1', type: 'paragraph', props: {}, content: [{ type: 'text', text: 'One', styles: {} }], children: [] },
        { id: 'r2', type: 'paragraph', props: {}, content: [{ type: 'text', text: 'Two', styles: {} }], children: [] },
      ],
      actor: { type: 'agent', id: w.agentId },
      source: 'agent',
    });
    const rows = await activity(w.tenant.id, w.page.id);
    expect(rows.map((r) => [r.blockId, r.actorType, r.actorId]).sort()).toEqual([
      ['r1', 'agent', w.agentId],
      ['r2', 'agent', w.agentId],
    ]);
    expect((await pageRow(w.tenant.id, w.page.id)).agentChangedAt).not.toBeNull();
  });

  test('two quick edits move the quiet snapshot job forward; an edit while it runs requests a rerun', async () => {
    const w = await buildReviewWorld(app);
    const { client, ids } = await blockIds(w.name, w.token('user', w.a.userId));

    editBlockText(client.doc, ids[0]!, ' first');
    await landed(w.name, ' first');
    const job1 = (await quietJob(w.tenant.id, w.page.id))!;
    expect(job1).toMatchObject({ status: 'queued' });
    expect(job1.payload).toEqual({
      pageId: w.page.id,
      reason: 'quiet',
      actorType: 'user',
      actorId: w.a.userId,
    });
    // run_at = now + the space's quiet seconds (default 120).
    expect(job1.runAt.getTime()).toBeGreaterThan(Date.now() + 100_000);

    await sleep(30);
    editBlockText(client.doc, ids[0]!, ' second');
    await landed(w.name, ' second');
    const job2 = (await quietJob(w.tenant.id, w.page.id))!;
    expect(job2.id).toBe(job1.id);
    expect(job2.runAt.getTime()).toBeGreaterThan(job1.runAt.getTime());

    // A worker claims it (due "now" from a point after its run_at).
    const claimed = await withTenantTx(w.tenant.id, (tx) =>
      claimJobs(tx, w.tenant.id, {
        now: new Date(Date.now() + 3_600_000),
        limit: 10,
        leaseSeconds: 600,
      })
    );
    expect(claimed.map((j) => j.id)).toContain(job1.id);

    editBlockText(client.doc, ids[0]!, ' third');
    await landed(w.name, ' third');
    const job3 = (await quietJob(w.tenant.id, w.page.id))!;
    expect(job3).toMatchObject({ status: 'running', rerunRequested: true });
  });

  test('bookkeeping for a repeat contributor waits while a snapshot holds the document lock', async () => {
    const w = await buildReviewWorld(app);
    const { client, ids } = await blockIds(w.name, w.token('user', w.a.userId));
    editBlockText(client.doc, ids[0]!, ' first edit');
    await landed(w.name, 'first edit');
    // A is pending now, so A's next pending insert hits ON CONFLICT DO NOTHING
    // (no foreign-key check). On real Postgres only the bookkeeping's explicit
    // FOR KEY SHARE makes it wait (bookkeepingLock.pg.test.ts proves that row
    // lock); PGlite runs one transaction at a time, so here this pins the
    // observable order: nothing lands until the snapshot's lock is released.
    expect(await pending(w.tenant.id, w.page.id)).toContain(`user:${w.a.userId}`);
    const before = await pageRow(w.tenant.id, w.page.id);

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const lockTaken = new Promise<void>((r) => (locked = r));
    const holder = withTenantTx(w.tenant.id, async (tx) => {
      await lockDocument(tx, w.tenant.id, w.page.id);
      locked();
      await gate;
    });
    await lockTaken;

    editBlockText(client.doc, ids[0]!, ' second edit');
    await waitFor(() => fragmentText(server.documents.get(w.name)!).includes('second edit'));
    const outcome = await Promise.race([
      collabSettle(server).then(() => 'landed'),
      sleep(300).then(() => 'waiting'),
    ]);
    expect(outcome).toBe('waiting');

    release();
    await holder;
    await collabSettle(server);
    const after = await pageRow(w.tenant.id, w.page.id);
    expect(after.liveUpdatedAtText > before.liveUpdatedAtText).toBe(true);
  });

  test('R20: the store marks the page changed, so a snapshot racing the store cannot clear it', async () => {
    const w = await buildReviewWorld(app);
    const { client, ids } = await blockIds(w.name, w.token('user', w.a.userId));
    const editTime = new Date();
    editBlockText(client.doc, ids[1]!, ' typed before the store');
    await landed(w.name, 'typed before the store');

    // A quiet snapshot runs before the debounced store: it reads the stored
    // (older) state and clears the flag, as nothing newer had landed yet.
    const version = await takePageSnapshot({
      tenantId: w.tenant.id,
      pageId: w.page.id,
      reason: 'quiet',
      actorType: 'user',
      actorId: w.a.userId,
      manual: false,
    });
    expect(version?.markdown).not.toContain('typed before the store');
    const between = await pageRow(w.tenant.id, w.page.id);
    expect(between.liveChangedSinceSnapshot).toBe(false);

    // Then the store lands: the page is changed since that snapshot again.
    await flushDocument(server, { documentName: w.name });
    const after = await pageRow(w.tenant.id, w.page.id);
    expect(after.liveChangedSinceSnapshot).toBe(true);
    expect(after.liveUpdatedAt.getTime()).toBeGreaterThanOrEqual(editTime.getTime());
    expect(after.liveUpdatedAtText > between.liveUpdatedAtText).toBe(true);

    // A store with nothing new to write leaves a fresh snapshot's flag alone.
    const v2 = await takePageSnapshot({
      tenantId: w.tenant.id,
      pageId: w.page.id,
      reason: 'quiet',
      actorType: 'user',
      actorId: w.a.userId,
      manual: false,
    });
    expect(v2?.markdown).toContain('typed before the store');
    expect((await pageRow(w.tenant.id, w.page.id)).liveChangedSinceSnapshot).toBe(false);
    await flushDocument(server, { documentName: w.name });
    expect((await pageRow(w.tenant.id, w.page.id)).liveChangedSinceSnapshot).toBe(false);
  });
});
