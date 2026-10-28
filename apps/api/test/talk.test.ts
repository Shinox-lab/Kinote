import { describe, test, beforeAll, afterEach, afterAll, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { users, withTenantTx } from '@living-wiki/db';
import { DeterministicEmbeddingProvider, DeterministicPlacementModel } from '@living-wiki/core';
import { collabSettle, type CollabServer } from '../../collab/src/server.js';
import { startCollabServer } from '../../collab/test/support/wsClient.js';
import { runPendingJobsForTenant } from '../../worker/src/runner.js';
import { InProcessCollabClient } from './support/inProcessCollab.js';
import { bootstrapTenant, buildTestApp, signUpMember, useTestDb } from './support/testkit.js';

type Headers = Record<string, string>;

/** A comment body as the comment editor writes it: one paragraph. */
const body = (text: string) => [{ type: 'paragraph', content: [{ type: 'text', text, styles: {} }] }];

describe('comments, mentions and notifications', () => {
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

  const send = (method: 'POST' | 'PATCH' | 'DELETE', headers: Headers, url: string, payload: unknown = {}) =>
    app.inject({ method, url, headers, payload: payload as any });
  const post = (headers: Headers, url: string, payload: unknown = {}) => send('POST', headers, url, payload);
  const get = (headers: Headers, url: string) => app.inject({ method: 'GET', url, headers });
  const run = (tenantId: string) =>
    runPendingJobsForTenant(tenantId, { collab, placementModel: model, embeddingProvider: embedder });

  async function world(opts: { review?: boolean } = {}) {
    const { tenant, owner, headers } = await bootstrapTenant(app, { name: 'Talk Co', slug: 'talk-co' });
    const space = (
      await post(headers, '/api/v1/spaces', { name: 'Team', slug: 'team', review_required: opts.review ?? false })
    ).json().id as string;
    const secret = (await post(headers, '/api/v1/spaces', { name: 'Secret', slug: 'secret' })).json().id as string;
    const member = async (name: string, role: 'viewer' | 'editor' | 'reviewer' | null) => {
      const m = await signUpMember(app, tenant.id, 'member', `${name.toLowerCase().replace(/ /g, '.')}@talk.test`);
      await withTenantTx(tenant.id, (tx) => tx.update(users).set({ name }).where(eq(users.id, m.userId)));
      if (role) {
        const g = await post(headers, `/api/v1/spaces/${space}/grants`, { principal_type: 'user', principal_id: m.userId, role });
        expect(g.statusCode, g.body).toBeLessThan(300);
      }
      return m;
    };
    const page = async (title: string, markdown: string, spaceId = space, as = headers) => {
      const res = await post(as, '/api/v1/pages', { space_id: spaceId, title, slug: title.toLowerCase().replace(/\W+/g, '-'), markdown });
      expect(res.statusCode, res.body).toBe(201);
      return res.json().id as string;
    };
    const snapshot = async (pageId: string, as = headers) => {
      const res = await post(as, `/api/v1/pages/${pageId}/snapshot`);
      expect(res.statusCode, res.body).toBeLessThan(300);
      await run(tenant.id);
      return res.json();
    };
    return { tenant, owner, headers, space, secret, member, page, snapshot };
  }

  const inbox = async (headers: Headers) => {
    const res = await get(headers, '/api/v1/notifications');
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as { unread: number; items: Array<Record<string, any>> };
  };

  describe('page mentions', () => {
    test('a mention notifies once, with the sentence; someone who cannot read the page is not told', async () => {
      const w = await world();
      const ed = await w.member('Ed Editor', 'editor');
      const outsider = await w.member('Olga Outside', null);
      const pageId = await w.page('Plan', `Ask [@Ed Editor](/u/${ed.userId}) and [@Olga Outside](/u/${outsider.userId}) today.`);
      await w.snapshot(pageId);
      await w.snapshot(pageId).catch(() => undefined);

      const box = await inbox(ed.headers);
      expect(box.unread).toBe(1);
      expect(box.items).toEqual([
        expect.objectContaining({
          kind: 'mention',
          documentId: pageId,
          documentTitle: 'Plan',
          excerpt: 'Ask @Ed Editor and @Olga Outside today.',
          readAt: null,
        }),
      ]);
      expect((await inbox(outsider.headers)).items).toEqual([]);
    });

    test('mentionable people: names matching the query, with whether they can read the page', async () => {
      const w = await world();
      await w.member('Ed Editor', 'editor');
      await w.member('Edna Outside', null);
      const pageId = await w.page('Plan', 'x');
      const res = await get(w.headers, `/api/v1/mentionable?page_id=${pageId}&q=ed`);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'Ed Editor', canRead: true }),
          expect.objectContaining({ name: 'Edna Outside', canRead: false }),
        ])
      );
    });
  });

  describe('threads', () => {
    test('an editor starts a thread; a reply notifies the starter; @Name in a comment mentions', async () => {
      const w = await world();
      const ed = await w.member('Ed Editor', 'editor');
      const ria = await w.member('Ria Reader', 'editor');
      const pageId = await w.page('Plan', 'The launch is in May.');

      const started = await post(ed.headers, `/api/v1/pages/${pageId}/threads`, {
        block_id: 'b1',
        quote: 'launch is in May',
        body: body('Is this still right?'),
      });
      expect(started.statusCode, started.body).toBe(201);
      const thread = started.json();
      expect(thread).toMatchObject({ documentId: pageId, blockId: 'b1', quote: 'launch is in May', resolved: false });
      expect(thread.comments).toEqual([expect.objectContaining({ authorName: 'Ed Editor', deletedAt: null })]);

      const reply = await post(ria.headers, `/api/v1/threads/${thread.id}/comments`, { body: body('No, June.') });
      expect(reply.statusCode, reply.body).toBe(201);
      let box = await inbox(ed.headers);
      expect(box.items).toEqual([
        expect.objectContaining({ kind: 'comment_reply', actorName: 'Ria Reader', threadId: thread.id, excerpt: 'No, June.' }),
      ]);

      // A reply that also mentions someone in the thread tells them once, as a mention.
      await post(ria.headers, `/api/v1/threads/${thread.id}/comments`, { body: body('@Ed Editor can you fix it?') });
      box = await inbox(ed.headers);
      expect(box.items.map((n) => n.kind)).toEqual(['mention', 'comment_reply']);
      // The replier is not told about their own reply.
      expect((await inbox(ria.headers)).items).toEqual([]);

      const list = await get(ed.headers, `/api/v1/pages/${pageId}/threads`);
      expect(list.json().map((t: { comments: unknown[] }) => t.comments.length)).toEqual([3]);
    });

    test('viewers read threads but cannot start or reply', async () => {
      const w = await world();
      const viewer = await w.member('Val Viewer', 'viewer');
      const pageId = await w.page('Plan', 'x');
      const t = (await post(w.headers, `/api/v1/pages/${pageId}/threads`, { body: body('Owner note') })).json();
      expect((await post(viewer.headers, `/api/v1/pages/${pageId}/threads`, { body: body('Hi') })).statusCode).toBe(403);
      expect((await post(viewer.headers, `/api/v1/threads/${t.id}/comments`, { body: body('Hi') })).statusCode).toBe(403);
      expect((await get(viewer.headers, `/api/v1/pages/${pageId}/threads`)).json()).toHaveLength(1);
    });

    test('only the author edits a comment; deleting keeps the place; resolve and reopen', async () => {
      const w = await world();
      const ed = await w.member('Ed Editor', 'editor');
      const pageId = await w.page('Plan', 'x');
      const t = (await post(ed.headers, `/api/v1/pages/${pageId}/threads`, { body: body('First') })).json();
      const commentId = t.comments[0].id as string;

      expect((await send('PATCH', w.headers, `/api/v1/comments/${commentId}`, { body: body('Hijack') })).statusCode).toBe(403);
      expect((await send('PATCH', ed.headers, `/api/v1/comments/${commentId}`, { body: body('First, edited') })).statusCode).toBe(200);

      expect((await post(ed.headers, `/api/v1/threads/${t.id}/resolve`)).json()).toMatchObject({ resolved: true });
      expect((await post(ed.headers, `/api/v1/threads/${t.id}/unresolve`)).json()).toMatchObject({ resolved: false });

      expect((await send('DELETE', ed.headers, `/api/v1/comments/${commentId}`)).statusCode).toBe(204);
      const [after] = (await get(ed.headers, `/api/v1/pages/${pageId}/threads`)).json();
      expect(after.comments[0]).toMatchObject({ body: null, deletedAt: expect.any(String) });

      expect((await send('DELETE', ed.headers, `/api/v1/threads/${t.id}`)).statusCode).toBe(204);
      expect((await get(ed.headers, `/api/v1/pages/${pageId}/threads`)).json()).toEqual([]);
    });

    test('a comment over 5,000 characters is refused', async () => {
      const w = await world();
      const pageId = await w.page('Plan', 'x');
      const res = await post(w.headers, `/api/v1/pages/${pageId}/threads`, { body: body('x'.repeat(5001)) });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('comment_too_long');
    });

    test('threads of a page the caller cannot read are not found', async () => {
      const w = await world();
      const ed = await w.member('Ed Editor', 'editor');
      const hidden = await w.page('Hidden', 'x', w.secret);
      expect((await get(ed.headers, `/api/v1/pages/${hidden}/threads`)).statusCode).toBe(404);
    });
  });

  describe('reviews and captures', () => {
    test('a page waiting for review tells the reviewers; approval tells the contributor', async () => {
      const w = await world({ review: true });
      const ed = await w.member('Ed Editor', 'editor');
      const rex = await w.member('Rex Reviewer', 'reviewer');
      const pageId = await w.page('Plan', 'Draft.', w.space, ed.headers);
      const version = await w.snapshot(pageId, ed.headers);

      const asked = await inbox(rex.headers);
      expect(asked.items).toEqual([expect.objectContaining({ kind: 'review_requested', documentId: pageId, actorName: 'Ed Editor' })]);
      expect((await inbox(ed.headers)).items).toEqual([]);

      const ok = await post(rex.headers, `/api/v1/versions/${version.id}/approve`);
      expect(ok.statusCode, ok.body).toBe(200);
      expect((await inbox(ed.headers)).items).toEqual([expect.objectContaining({ kind: 'review_approved', documentId: pageId, actorName: 'Rex Reviewer' })]);
    });

    test('a capture with something waiting for a place tells its sender once', async () => {
      const w = await world();
      const cap = await post(w.headers, '/api/v1/captures', { text: 'Zebras migrate in spring.' });
      expect(cap.statusCode, cap.body).toBe(201);
      await run(w.tenant.id);
      const box = await inbox(w.headers);
      expect(box.items.filter((n) => n.kind === 'capture_waiting')).toEqual([
        expect.objectContaining({ captureId: cap.json().id, actorName: 'Routing engine' }),
      ]);
    });
  });

  describe('the bell', () => {
    test('mark one read, then all; items about pages the reader lost access to are hidden', async () => {
      const w = await world();
      const ed = await w.member('Ed Editor', 'editor');
      const a = await w.page('Alpha', `Hi [@Ed Editor](/u/${ed.userId}).`);
      const b = await w.page('Beta', `Hey [@Ed Editor](/u/${ed.userId}).`);
      await w.snapshot(a);
      await w.snapshot(b);
      let box = await inbox(ed.headers);
      expect(box.unread).toBe(2);

      const first = box.items[0]!.id as string;
      expect((await post(ed.headers, '/api/v1/notifications/read', { ids: [first] })).json()).toMatchObject({ unread: 1 });
      expect((await post(ed.headers, '/api/v1/notifications/read', {})).json()).toMatchObject({ unread: 0 });

      expect((await post(w.headers, `/api/v1/pages/${b}/move`, { target_space_id: w.secret })).statusCode).toBe(200);
      box = await inbox(ed.headers);
      expect(box.items.map((n) => n.documentTitle)).toEqual(['Alpha']);
    });
  });
});
