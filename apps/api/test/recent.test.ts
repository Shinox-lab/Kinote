import { describe, test, expect } from 'vitest';
import { blockActivity, withTenantTx } from '@living-wiki/db';
import { InMemoryObjectStorage } from '@living-wiki/shared';
import { bootstrapTenant, signUpMember, buildTestApp, useTestDb } from './support/testkit.js';
import { uploadRequest } from './support/multipart.js';

describe('GET /api/v1/recent', () => {
  const app = buildTestApp({ storage: new InMemoryObjectStorage() });
  useTestDb();

  async function setup() {
    const { tenant, headers, inboxSpace } = await bootstrapTenant(app, { name: 'Recent Co', slug: 'recent-co' });
    const space = await post(headers, '/api/v1/spaces', { name: 'Docs', slug: 'docs', review_required: false });
    const editor = await signUpMember(app, tenant.id, 'member');
    await post(headers, `/api/v1/spaces/${space.id}/grants`, {
      principal_type: 'user',
      principal_id: editor.userId,
      role: 'editor',
    });
    return { tenant, headers, space, inbox: inboxSpace, editor };
  }
  type World = Awaited<ReturnType<typeof setup>>;

  async function post(headers: Record<string, string>, url: string, payload: unknown) {
    const res = await app.inject({ method: 'POST', url, headers, payload: payload as any });
    expect(res.statusCode, res.body).toBe(201);
    return res.json() as any;
  }

  async function page(w: World, title: string, slug: string) {
    return post(w.editor.headers, '/api/v1/pages', {
      space_id: w.space.id,
      title,
      slug,
      markdown: 'text',
    });
  }

  async function changed(w: World, pageId: string, blockId: string, at: Date) {
    await withTenantTx(w.tenant.id, (tx) =>
      tx.insert(blockActivity).values({
        tenantId: w.tenant.id,
        pageId,
        blockId,
        actorType: 'user',
        actorId: w.editor.userId,
        changedAt: at,
      })
    );
  }

  async function recent(w: World, limit = 3) {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/recent?limit=${limit}`,
      headers: w.editor.headers,
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as any[];
  }

  test('pages changed by the caller and files they uploaded, newest first, deduped', async () => {
    const w = await setup();
    const a = await page(w, 'Page A', 'page-a');
    const b = await page(w, 'Page B', 'page-b');
    const now = Date.now();
    await changed(w, a.id, 'a1', new Date(now - 3 * 3600_000));
    await changed(w, b.id, 'b1', new Date(now - 2 * 3600_000));
    await changed(w, a.id, 'a2', new Date(now - 3600_000));

    const upload = await app.inject(
      uploadRequest('/api/v1/files', w.editor.headers, { name: 'notes.txt', data: 'hello' }, { space_id: w.space.id })
    );
    expect(upload.statusCode, upload.body).toBe(201);

    const items = await recent(w);
    expect(items.map((item) => item.title)).toEqual(['notes.txt', 'Page A', 'Page B']);
    expect(items.every((item) => item.spaceName === 'Docs')).toBe(true);
    expect(items.filter((item) => item.title === 'Page A')).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'file', icon: null });
    expect(items[1]).toMatchObject({ kind: 'page', icon: null });

    expect((await recent(w, 2)).map((item) => item.title)).toEqual(['notes.txt', 'Page A']);
  });

  test('an Inbox page created by someone else does not leak into Recent', async () => {
    const w = await setup();
    const theirs = await post(w.headers, '/api/v1/pages', {
      space_id: w.inbox.id,
      title: 'Their private note',
      slug: 'their-private-note',
      markdown: 'private',
    });
    const mine = await post(w.editor.headers, '/api/v1/pages', {
      space_id: w.inbox.id,
      title: 'My private note',
      slug: 'my-private-note',
      markdown: 'mine',
    });
    await changed(w, theirs.id, 'theirs', new Date(Date.now() - 2000));
    await changed(w, mine.id, 'mine', new Date(Date.now() - 1000));

    const titles = (await recent(w)).map((item) => item.title);
    expect(titles).toContain('My private note');
    expect(titles).not.toContain('Their private note');
  });

  test('a page icon travels in the recent item', async () => {
    const w = await setup();
    const a = await page(w, 'Icon page', 'icon-page');
    await changed(w, a.id, 'a1', new Date());
    const set = await app.inject({
      method: 'PATCH',
      url: `/api/v1/pages/${a.id}`,
      headers: w.editor.headers,
      payload: { icon: '🚀' },
    });
    expect(set.statusCode, set.body).toBe(200);
    expect((await recent(w))[0]).toMatchObject({ id: a.id, icon: '🚀' });
  });

  test('needs a session and a sane limit', async () => {
    const w = await setup();
    const unauth = await app.inject({ method: 'GET', url: '/api/v1/recent' });
    expect(unauth.statusCode).toBe(401);
    const tooMany = await app.inject({
      method: 'GET',
      url: '/api/v1/recent?limit=11',
      headers: w.editor.headers,
    });
    expect(tooMany.statusCode).toBe(400);
  });
});
