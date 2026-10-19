import { describe, test, beforeAll, afterEach, afterAll, expect } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { withTenantTx, versions } from '@living-wiki/db';
import { VersionSummarySchema } from '@living-wiki/contracts';
import { blocksFromMarkdown, type RealBlock } from '../../../packages/core/test/fixtures/realBlocks.js';
import { collabSettle, type CollabServer } from '../../collab/src/server.js';
import { connectClient, startCollabServer, type ConnectedClient } from '../../collab/test/support/wsClient.js';
import { readBlocks, fragmentText } from '../../collab/test/support/blocks.js';
import { editBlockText } from '../../collab/test/support/editBlock.js';
import { buildReviewWorld, waitFor } from '../../collab/test/support/collabWorld.js';
import { runPendingJobsForTenant } from '../../worker/src/runner.js';
import { diffBlocks, type BlockDiffEntry } from '../src/pages/diff.js';
import { InProcessCollabClient } from './support/inProcessCollab.js';
import { bootstrapTenant, signUpMember, buildTestApp, useTestDb } from './support/testkit.js';

const A = { blockId: '', actorType: 'user' as const, actorId: 'user-a' };

/** A deep copy: real parsed blocks get fresh random ids per parse, so before/after pairs are copies of one parse. */
const copy = (blocks: RealBlock[]): RealBlock[] => structuredClone(blocks);

function setText(block: RealBlock, text: string): void {
  (block as any).content = [{ type: 'text', text, styles: {} }];
}

function find(entries: BlockDiffEntry[], blockId: string): BlockDiffEntry {
  const e = entries.find((x) => x.blockId === blockId);
  if (!e) throw new Error(`no entry for ${blockId}`);
  return e;
}

describe('diffBlocks (real BlockNote blocks)', () => {
  const md = '# Title\n\nFirst paragraph.\n\nSecond paragraph.\n\nThird paragraph.';

  test('identical blocks are all unchanged, carrying the after text and no author', async () => {
    const before = await blocksFromMarkdown(md);
    const after = copy(before);
    const activity = before.map((b) => ({ blockId: b.id, actorType: 'user' as const, actorId: 'u' }));
    const diff = diffBlocks(before, after, activity);
    expect(diff.map((d) => d.blockId)).toEqual(before.map((b) => b.id));
    expect(diff.map((d) => d.change)).toEqual(['unchanged', 'unchanged', 'unchanged', 'unchanged']);
    expect(diff[1]).toEqual({ blockId: before[1]!.id, change: 'unchanged', after: 'First paragraph.' });
    expect(diff.some((d) => d.author)).toBe(false);
    expect(diff.some((d) => d.before !== undefined)).toBe(false);
  });

  test('a text edit is changed with before, after and the author from activity', async () => {
    const before = await blocksFromMarkdown(md);
    const after = copy(before);
    setText(after[2]!, 'Second paragraph, edited.');
    const diff = diffBlocks(before, after, [
      { ...A, blockId: after[2]!.id },
      { ...A, blockId: after[1]!.id, actorId: 'someone-else' },
    ]);
    expect(find(diff, after[2]!.id)).toEqual({
      blockId: after[2]!.id,
      change: 'changed',
      before: 'Second paragraph.',
      after: 'Second paragraph, edited.',
      author: { type: 'user', id: 'user-a' },
    });
    // The other block has activity but did not change: no author.
    expect(find(diff, after[1]!.id).author).toBeUndefined();
    expect(find(diff, after[1]!.id).change).toBe('unchanged');
  });

  test('a type change and a heading level change are changed', async () => {
    const before = await blocksFromMarkdown(md);
    const after = copy(before);
    after[1]!.type = 'bulletListItem' as any;
    (after[0] as any).props = { ...(after[0] as any).props, level: 2 };
    const diff = diffBlocks(before, after, []);
    expect(find(diff, after[0]!.id)).toMatchObject({ change: 'changed', before: 'Title', after: 'Title' });
    expect(find(diff, after[1]!.id)).toMatchObject({
      change: 'changed',
      before: 'First paragraph.',
      after: 'First paragraph.',
    });
    expect(find(diff, after[2]!.id).change).toBe('unchanged');
  });

  test('an inserted block is added (with its author) at its position in after', async () => {
    const before = await blocksFromMarkdown(md);
    const after = copy(before);
    const inserted = structuredClone(before[2]!);
    inserted.id = 'new-block-id';
    setText(inserted, 'Brand new.');
    after.splice(2, 0, inserted);
    const diff = diffBlocks(before, after, [{ ...A, blockId: 'new-block-id', actorType: 'agent' }]);
    expect(diff.map((d) => d.blockId)).toEqual([
      before[0]!.id,
      before[1]!.id,
      'new-block-id',
      before[2]!.id,
      before[3]!.id,
    ]);
    expect(find(diff, 'new-block-id')).toEqual({
      blockId: 'new-block-id',
      change: 'added',
      after: 'Brand new.',
      author: { type: 'agent', id: 'user-a' },
    });
    expect(diff.filter((d) => d.change !== 'added').every((d) => d.change === 'unchanged')).toBe(true);
  });

  test('a deleted block is removed, placed after its nearest surviving predecessor, with no author', async () => {
    const before = await blocksFromMarkdown(md);
    const after = copy(before);
    const [gone] = after.splice(2, 1);
    const diff = diffBlocks(before, after, [{ ...A, blockId: gone!.id }]);
    expect(diff.map((d) => d.blockId)).toEqual([
      before[0]!.id,
      before[1]!.id,
      before[2]!.id,
      before[3]!.id,
    ]);
    expect(diff.map((d) => d.change)).toEqual(['unchanged', 'unchanged', 'removed', 'unchanged']);
    expect(diff[2]).toEqual({ blockId: before[2]!.id, change: 'removed', before: 'Second paragraph.' });
  });

  test('a removed first block comes first; consecutive removals keep their order', async () => {
    const before = await blocksFromMarkdown(md);
    const first = copy(before);
    first.splice(0, 2);
    const diff = diffBlocks(before, first, []);
    expect(diff.map((d) => `${d.change}`)).toEqual(['removed', 'removed', 'unchanged', 'unchanged']);
    expect(diff.map((d) => d.blockId)).toEqual(before.map((b) => b.id));

    // The predecessor of a removed block may itself be removed: it follows the nearest SURVIVING one.
    const mid = copy(before);
    mid.splice(1, 2);
    const diff2 = diffBlocks(before, mid, []);
    expect(diff2.map((d) => d.blockId)).toEqual(before.map((b) => b.id));
    expect(diff2.map((d) => d.change)).toEqual(['unchanged', 'removed', 'removed', 'unchanged']);
  });

  test('a pure reorder is not a change', async () => {
    const before = await blocksFromMarkdown(md);
    const after = copy(before);
    [after[1], after[3]] = [after[3]!, after[1]!];
    const diff = diffBlocks(before, after, before.map((b) => ({ ...A, blockId: b.id })));
    expect(diff.map((d) => d.blockId)).toEqual(after.map((b) => b.id));
    expect(diff.every((d) => d.change === 'unchanged')).toBe(true);
    expect(diff.some((d) => d.author)).toBe(false);
  });

  test('nested children are aligned by id too', async () => {
    const before = await blocksFromMarkdown('- parent\n  - child one\n  - child two');
    const after = copy(before);
    const child = (after[0] as any).children[0] as RealBlock;
    setText(child, 'child one!');
    const diff = diffBlocks(before, after, []);
    expect(diff.map((d) => d.change)).toEqual(['unchanged', 'changed', 'unchanged']);
  });

  test('everything is added against an empty before', async () => {
    const after = await blocksFromMarkdown(md);
    const diff = diffBlocks([], after, []);
    expect(diff.map((d) => d.change)).toEqual(['added', 'added', 'added', 'added']);
  });
});

/**
 * The version, changes and compare routes over a real collab edit: a review
 * space with an indexed v1, then user A edits through a websocket.
 */
describe('version history, changes and compare routes', () => {
  const h = {} as { server: CollabServer; port: number; app: ReturnType<typeof buildTestApp>; clients: ConnectedClient[] };
  h.clients = [];

  beforeAll(async () => {
    ({ server: h.server, port: h.port } = await startCollabServer(undefined, {
      debounceMs: 60_000,
      maxDebounceMs: 60_000,
    }));
    h.app = buildTestApp({ collab: new InProcessCollabClient(h.server) });
  });
  useTestDb();
  afterEach(async () => {
    for (const c of h.clients.splice(0)) c.destroy();
    await collabSettle(h.server);
  });
  afterAll(async () => {
    await h.server.server.destroy();
  });

  type World = Awaited<ReturnType<typeof buildReviewWorld>>;

  const get = (url: string, headers: Record<string, string>) => h.app.inject({ method: 'GET', url, headers });

  async function snapshot(w: World, headers: Record<string, string>) {
    const res = await h.app.inject({ method: 'POST', url: `/api/v1/pages/${w.page.id}/snapshot`, headers });
    expect(res.statusCode, res.body).toBe(201);
    return res.json();
  }

  /** v1 indexed (approved by R, worker run). */
  async function indexedV1(w: World) {
    const v1 = await snapshot(w, w.headers);
    const approved = await h.app.inject({
      method: 'POST',
      url: `/api/v1/versions/${v1.id}/approve`,
      headers: w.r.headers,
      payload: {},
    });
    expect(approved.statusCode, approved.body).toBe(200);
    await runPendingJobsForTenant(w.tenant.id);
    return v1;
  }

  async function editAs(w: World, principalId: string, blockIndex: number, text: string) {
    const client = await connectClient({ port: h.port, documentName: w.name, token: w.token('user', principalId) });
    h.clients.push(client);
    editBlockText(client.doc, readBlocks(client.doc)[blockIndex]!.id as string, text);
    await waitFor(() => fragmentText(h.server.documents.get(w.name)!).includes(text));
    await collabSettle(h.server);
  }

  async function storedBlocks(tenantId: string, versionId: string): Promise<RealBlock[]> {
    const [row] = await withTenantTx(tenantId, (tx) =>
      tx
        .select({ blocks: versions.blocks })
        .from(versions)
        .where(and(eq(versions.tenantId, tenantId), eq(versions.id, versionId)))
    );
    return row!.blocks as RealBlock[];
  }

  test('changes: the indexed version against live content, authored from block_activity', async () => {
    const w = await buildReviewWorld(h.app);
    const v1 = await indexedV1(w);
    await editAs(w, w.a.userId, 1, ' A was here');
    // Live content reaches pages.ydoc_state through the flush a snapshot does.
    await snapshot(w, w.b.headers);

    // A viewer may read it.
    const res = await get(`/api/v1/pages/${w.page.id}/changes`, w.v.headers);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as BlockDiffEntry[];
    const v1Blocks = await storedBlocks(w.tenant.id, v1.id);
    expect(body.map((e) => e.blockId)).toEqual(v1Blocks.map((b) => b.id));
    expect(body.map((e) => e.change)).toEqual(['unchanged', 'changed', 'unchanged']);
    expect(body[1]).toEqual({
      blockId: v1Blocks[1]!.id,
      change: 'changed',
      before: 'Second paragraph.',
      after: 'Second paragraph. A was here',
      // /changes alone names its authors (exact names: changesNames.test.ts).
      author: { type: 'user', id: w.a.userId, name: expect.stringMatching(/\S/) },
    });
  });

  test('changes: everything is added when nothing is indexed', async () => {
    const w = await buildReviewWorld(h.app);
    const res = await get(`/api/v1/pages/${w.page.id}/changes`, w.headers);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as BlockDiffEntry[];
    expect(body.length).toBe(3);
    expect(body.every((e) => e.change === 'added')).toBe(true);
    expect(body[0]!.after).toBe('First paragraph.');
  });

  test('compare equals diffBlocks of the two stored versions; version diff is against the indexed one', async () => {
    const w = await buildReviewWorld(h.app);
    const v1 = await indexedV1(w);
    await editAs(w, w.a.userId, 1, ' A was here');
    const v2 = await snapshot(w, w.b.headers);

    const expected = diffBlocks(
      await storedBlocks(w.tenant.id, v1.id),
      await storedBlocks(w.tenant.id, v2.id),
      []
    );
    const res = await get(`/api/v1/pages/${w.page.id}/compare?from=1&to=2`, w.v.headers);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual(expected);
    expect((res.json() as BlockDiffEntry[]).map((e) => e.change)).toEqual(['unchanged', 'changed', 'unchanged']);

    // v2 against the indexed v1 is the same diff; v1 against itself is all unchanged.
    const vd2 = await get(`/api/v1/versions/${v2.id}/diff`, w.v.headers);
    expect(vd2.statusCode, vd2.body).toBe(200);
    expect(vd2.json()).toEqual(expected);
    const vd1 = await get(`/api/v1/versions/${v1.id}/diff`, w.v.headers);
    expect(vd1.statusCode, vd1.body).toBe(200);
    expect((vd1.json() as BlockDiffEntry[]).map((e) => e.change)).toEqual(['unchanged', 'unchanged', 'unchanged']);

    // Compare in the reverse direction swaps before and after.
    const rev = await get(`/api/v1/pages/${w.page.id}/compare?from=2&to=1`, w.headers);
    expect((rev.json() as BlockDiffEntry[])[1]).toMatchObject({
      change: 'changed',
      before: 'Second paragraph. A was here',
      after: 'Second paragraph.',
    });
  });

  test('version diff: a never-indexed document shows every block added; the indexed version itself is unchanged; a pending v2 shows changes against indexed v1', async () => {
    const w = await buildReviewWorld(h.app);
    // Review space, nothing approved: v1 is pending_review and nothing is indexed.
    const first = await snapshot(w, w.headers);
    expect(first.status).toBe('pending_review');
    const none = await get(`/api/v1/versions/${first.id}/diff`, w.v.headers);
    expect(none.statusCode, none.body).toBe(200);
    const added = none.json() as BlockDiffEntry[];
    expect(added.map((e) => e.change)).toEqual(['added', 'added', 'added']);
    expect(added.map((e) => e.after)).toEqual(['First paragraph.', 'Second paragraph.', 'Third paragraph.']);

    // Approve and index it: it is now the indexed version, all unchanged.
    const approved = await h.app.inject({
      method: 'POST',
      url: `/api/v1/versions/${first.id}/approve`,
      headers: w.r.headers,
      payload: {},
    });
    expect(approved.statusCode, approved.body).toBe(200);
    await runPendingJobsForTenant(w.tenant.id);
    const self = await get(`/api/v1/versions/${first.id}/diff`, w.v.headers);
    expect((self.json() as BlockDiffEntry[]).map((e) => e.change)).toEqual(['unchanged', 'unchanged', 'unchanged']);

    // A pending v2 differs from the indexed v1.
    await editAs(w, w.a.userId, 2, ' edited');
    const v2 = await snapshot(w, w.b.headers);
    expect(v2.status).toBe('pending_review');
    const vs = await get(`/api/v1/versions/${v2.id}/diff`, w.v.headers);
    expect((vs.json() as BlockDiffEntry[]).map((e) => e.change)).toEqual(['unchanged', 'unchanged', 'changed']);
  });

  test('compare: bad params are 400 validation_failed, an unknown number is 404 version_not_found', async () => {
    const w = await buildReviewWorld(h.app);
    await indexedV1(w);
    for (const q of ['', '?from=1', '?to=1', '?from=0&to=1', '?from=-1&to=1', '?from=a&to=1', '?from=1.5&to=1', '?from=99999999999&to=1', '?from=1&to=99999999999', '?from=1&to=1&from=2']) {
      const res = await get(`/api/v1/pages/${w.page.id}/compare${q}`, w.headers);
      expect(res.statusCode, q).toBe(400);
      expect(res.json().error).toBe('validation_failed');
    }
    const unknown = await get(`/api/v1/pages/${w.page.id}/compare?from=1&to=9`, w.headers);
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error).toBe('version_not_found');
  });

  test('versions: newest first with exactly the VersionSummary keys plus the author name', async () => {
    const w = await buildReviewWorld(h.app);
    await indexedV1(w);
    await editAs(w, w.a.userId, 0, ' more');
    await snapshot(w, w.b.headers);
    const res = await get(`/api/v1/pages/${w.page.id}/versions`, w.v.headers);
    expect(res.statusCode, res.body).toBe(200);
    const list = res.json() as any[];
    expect(list.map((v) => v.number)).toEqual([2, 1]);
    for (const v of list) {
      // The VersionSummary keys (12, as everywhere else) plus the author's name, which only the history list adds.
      expect(Object.keys(v).sort()).toEqual([...Object.keys(VersionSummarySchema.shape), 'createdByName'].sort());
      expect(Object.keys(v)).toHaveLength(13);
    }
  });

  test('version detail: markdown, blocks and named contributors, never the Yjs snapshot', async () => {
    const w = await buildReviewWorld(h.app);
    await editAs(w, w.a.userId, 0, ' A wrote');
    const v1 = await snapshot(w, w.b.headers);

    const res = await get(`/api/v1/versions/${v1.id}`, w.v.headers);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(Object.keys(body)).not.toContain('ydocSnapshot');
    expect(Object.keys(body)).not.toContain('ydoc_snapshot');
    expect(res.body).not.toContain('ydocSnapshot');
    expect(body.id).toBe(v1.id);
    expect(body.markdown).toContain('First paragraph. A wrote');
    expect(Array.isArray(body.blocks)).toBe(true);
    expect(body.blocks).toHaveLength(3);
    const ids = body.contributors.map((c: any) => c.id).sort();
    expect(ids).toEqual([w.owner.userId, w.a.userId, w.b.userId].sort());
    for (const c of body.contributors) {
      expect(c.type).toBe('user');
      expect(c.isAgent).toBe(false);
      expect(typeof c.name).toBe('string');
      expect(c.name.length).toBeGreaterThan(0);
    }
  });

  test('version detail names an agent contributor and flags isAgent', async () => {
    const w = await buildReviewWorld(h.app);
    const { withTenantTx: tx, versionContributors } = await import('@living-wiki/db');
    const v1 = await snapshot(w, w.headers);
    await tx(w.tenant.id, (t) =>
      t.insert(versionContributors).values({
        tenantId: w.tenant.id,
        versionId: v1.id,
        principalType: 'agent',
        principalId: w.agentId,
      })
    );
    const res = await get(`/api/v1/versions/${v1.id}`, w.headers);
    const agent = (res.json().contributors as any[]).find((c) => c.type === 'agent');
    expect(agent).toMatchObject({ id: w.agentId, isAgent: true });
    expect(agent.name).toMatch(/^agent-/);
  });

  test('hidden documents answer exactly like unknown ids on every read', async () => {
    const owner = await bootstrapTenant(h.app, { name: 'Inbox Co', slug: 'inbox-co' });
    const m1 = await signUpMember(h.app, owner.tenant.id, 'member');
    const m2 = await signUpMember(h.app, owner.tenant.id, 'member');
    const created = await h.app.inject({
      method: 'POST',
      url: '/api/v1/pages',
      headers: m1.headers,
      payload: { space_id: owner.inboxSpace.id, title: 'Mine', slug: 'mine', markdown: 'Private text.' },
    });
    expect(created.statusCode, created.body).toBe(201);
    const pageId = created.json().id as string;
    const snap = await h.app.inject({ method: 'POST', url: `/api/v1/pages/${pageId}/snapshot`, headers: m1.headers });
    expect(snap.statusCode, snap.body).toBe(201);
    const versionId = snap.json().id as string;

    const unknownPage = '00000000-0000-4000-8000-000000000001';
    const pageUrls = (id: string) => [
      `/api/v1/pages/${id}/versions`,
      `/api/v1/pages/${id}/changes`,
      `/api/v1/pages/${id}/compare?from=1&to=1`,
    ];
    const versionUrls = (id: string) => [`/api/v1/versions/${id}`, `/api/v1/versions/${id}/diff`];

    // The creator and a tenant admin (the owner) can read them.
    for (const url of [...pageUrls(pageId), ...versionUrls(versionId)]) {
      expect((await get(url, m1.headers)).statusCode, url).toBe(200);
      expect((await get(url, owner.headers)).statusCode, url).toBe(200);
    }
    // Another member gets the unknown-id answer, byte for byte.
    for (const [hidden, unknown] of [
      ...pageUrls(pageId).map((u, i) => [u, pageUrls(unknownPage)[i]!] as const),
      ...versionUrls(versionId).map((u, i) => [u, versionUrls(unknownPage)[i]!] as const),
    ]) {
      const a = await get(hidden, m2.headers);
      const b = await get(unknown, m2.headers);
      expect(a.statusCode, hidden).toBe(404);
      expect(a.body, hidden).toBe(b.body);
    }
  });

  test('invalid uuids are 404 like unknown ones', async () => {
    const w = await buildReviewWorld(h.app);
    for (const url of [
      '/api/v1/pages/nope/versions',
      '/api/v1/pages/nope/changes',
      '/api/v1/pages/nope/compare?from=1&to=1',
      '/api/v1/versions/nope',
      '/api/v1/versions/nope/diff',
    ]) {
      const res = await get(url, w.headers);
      expect(res.statusCode, url).toBe(404);
    }
  });
});
