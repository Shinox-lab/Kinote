import { describe, test, beforeAll, afterEach, afterAll, expect } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { documents, pageFieldValues, withTenantTx } from '@kinote/db';
import { DeterministicEmbeddingProvider } from '@kinote/core';
import { collabSettle, type CollabServer } from '../../collab/src/server.js';
import { startCollabServer } from '../../collab/test/support/wsClient.js';
import { InProcessCollabClient } from './support/inProcessCollab.js';
import { bootstrapTenant, buildTestApp, signUpMember, useTestDb } from './support/testkit.js';

type Headers = Record<string, string>;

/** The rows a collection view shows (spec C7, C8). */
describe('collection rows for views', () => {
  let server: CollabServer;
  let collab: InProcessCollabClient;
  let app: ReturnType<typeof buildTestApp>;

  beforeAll(async () => {
    ({ server } = await startCollabServer(undefined, { debounceMs: 60_000, maxDebounceMs: 60_000 }));
    collab = new InProcessCollabClient(server);
    app = buildTestApp({ collab, embeddingProvider: new DeterministicEmbeddingProvider() });
  });
  useTestDb();
  afterEach(async () => {
    await collabSettle(server);
  });
  afterAll(async () => {
    await server.server.destroy();
  });

  const req = (method: string, headers: Headers, url: string, payload?: unknown) =>
    app.inject({ method: method as any, url, headers, ...(payload !== undefined ? { payload: payload as any } : {}) });

  async function world() {
    const { tenant, headers, owner } = await bootstrapTenant(app, { name: 'Views Co', slug: 'views-co' });
    const space = (await req('POST', headers, '/api/v1/spaces', { name: 'Clients', slug: 'clients' })).json().id as string;
    const page = async (title: string, parentId: string | null = null, spaceId = space) => {
      const res = await req('POST', headers, '/api/v1/pages', {
        space_id: spaceId,
        parent_id: parentId,
        title,
        slug: title.toLowerCase().replace(/\W+/g, '-'),
        markdown: `${title}.`,
      });
      expect(res.statusCode, res.body).toBe(201);
      return res.json().id as string;
    };
    const clients = await page('Clients');
    expect((await req('POST', headers, `/api/v1/pages/${clients}/collection`)).statusCode).toBe(201);
    const field = async (body: unknown) => (await req('POST', headers, `/api/v1/collections/${clients}/fields`, body)).json();
    const status = await field({
      name: 'Status',
      type: 'select',
      options: { choices: [{ id: 'lead', name: 'Lead', color: 'gray' }, { id: 'active', name: 'Active', color: 'green' }] },
    });
    const owners = await field({ name: 'Owner', type: 'person' });
    const count = await field({ name: 'Count', type: 'number' });
    const set = async (pageId: string, values: Record<string, unknown>) => {
      const res = await req('PATCH', headers, `/api/v1/pages/${pageId}/fields`, values);
      expect(res.statusCode, res.body).toBe(200);
    };
    const george = await page('George', clients);
    const tavros = await page('Tavros', clients);
    const acme = await page('Acme', clients);
    await set(george, { [status.id]: 'active', [owners.id]: [owner.userId], [count.id]: 3 });
    await set(tavros, { [status.id]: 'lead', [count.id]: 10 });
    return { tenant, headers, owner, space, page, clients, status, owners, count, george, tavros, acme };
  }

  const rows = (headers: Headers, collectionId: string, body: unknown = {}) => req('POST', headers, `/api/v1/collections/${collectionId}/rows`, body);

  test("date windows use the viewer's own day when it is sent", async () => {
    const w = await world();
    const launch = (await req('POST', w.headers, `/api/v1/collections/${w.clients}/fields`, { name: 'Launch', type: 'date' })).json();
    expect((await req('PATCH', w.headers, `/api/v1/pages/${w.george}/fields`, { [launch.id]: { start: '2026-11-02' } })).statusCode).toBe(200);
    const thisWeek = (today: string) =>
      rows(w.headers, w.clients, { filters: [{ fieldId: launch.id, op: 'this_week' }], today }).then((r) => r.json().rows.map((x: { title: string }) => x.title));
    // Sunday 1 Nov and Monday 2 Nov are in different weeks.
    expect(await thisWeek('2026-11-02')).toEqual(['George']);
    expect(await thisWeek('2026-11-01')).toEqual([]);
    expect((await rows(w.headers, w.clients, { today: 'soon' })).statusCode).toBe(400);
  });

  test('filters and sorts on the server; values are the ones that fit', async () => {
    const w = await world();
    const all = await rows(w.headers, w.clients, { sorts: [{ fieldId: 'title', dir: 'asc' }] });
    expect(all.statusCode, all.body).toBe(200);
    expect(all.json()).toMatchObject({ collection: { id: w.clients, title: 'Clients' }, spaceId: w.space, canEdit: true, truncated: false });
    expect(all.json().rows.map((r: { title: string }) => r.title)).toEqual(['Acme', 'George', 'Tavros']);
    expect(all.json().rows[1].values).toEqual({ [w.status.id]: 'active', [w.owners.id]: [w.owner.userId], [w.count.id]: 3 });

    const mine = await rows(w.headers, w.clients, { filters: [{ fieldId: w.owners.id, op: 'contains', value: 'me' }] });
    expect(mine.json().rows.map((r: { title: string }) => r.title)).toEqual(['George']);

    const byCount = await rows(w.headers, w.clients, { sorts: [{ fieldId: w.count.id, dir: 'desc' }] });
    expect(byCount.json().rows.map((r: { title: string }) => r.title)).toEqual(['Tavros', 'George', 'Acme']);
  });

  test('archived rows, grandchildren and files are left out; a stale value is ignored', async () => {
    const w = await world();
    await w.page('George notes', w.george);
    expect((await req('POST', w.headers, `/api/v1/pages/${w.acme}/archive`)).statusCode).toBe(200);
    await withTenantTx(w.tenant.id, (tx) =>
      tx.update(pageFieldValues).set({ value: 'not-a-choice' }).where(and(eq(pageFieldValues.pageId, w.tavros), eq(pageFieldValues.fieldId, w.status.id)))
    );
    const res = (await rows(w.headers, w.clients)).json();
    expect(res.rows.map((r: { title: string }) => r.title).sort()).toEqual(['George', 'Tavros']);
    expect(res.rows.find((r: { title: string }) => r.title === 'Tavros').values).toEqual({ [w.count.id]: 10 });
  });

  test('at most 1,000 rows, then truncated', async () => {
    const w = await world();
    await withTenantTx(w.tenant.id, async (tx) => {
      const [parent] = await tx.select().from(documents).where(eq(documents.id, w.clients));
      const extra = Array.from({ length: 1000 }, (_, i) => ({
        tenantId: w.tenant.id,
        spaceId: w.space,
        parentId: w.clients,
        kind: 'page' as const,
        title: `Bulk ${i}`,
        createdByType: 'user' as const,
        createdBy: parent!.createdBy,
      }));
      await tx.insert(documents).values(extra);
    });
    const res = (await rows(w.headers, w.clients)).json();
    expect(res.rows).toHaveLength(1000);
    expect(res.truncated).toBe(true);
  });

  test('no access shows nothing', async () => {
    const w = await world();
    const outsider = await signUpMember(app, w.tenant.id, 'member');
    const res = await rows(outsider.headers, w.clients);
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('collection_not_found');
    expect(res.body).not.toContain('Clients');
    expect((await req('GET', outsider.headers, '/api/v1/collections?q=')).json()).toEqual([]);
  });

  test('a viewer reads rows but can’t edit them', async () => {
    const w = await world();
    const viewer = await signUpMember(app, w.tenant.id, 'member');
    await req('POST', w.headers, `/api/v1/spaces/${w.space}/grants`, { principal_type: 'user', principal_id: viewer.userId, role: 'viewer' });
    const res = await rows(viewer.headers, w.clients);
    expect(res.json()).toMatchObject({ canEdit: false });
    expect(res.json().rows).toHaveLength(3);
  });

  test('a page that is not a collection is collection_not_found', async () => {
    const w = await world();
    expect((await rows(w.headers, w.george)).statusCode).toBe(404);
  });

  test('the picker lists readable collections', async () => {
    const w = await world();
    const other = (await req('POST', w.headers, '/api/v1/spaces', { name: 'Projects', slug: 'projects' })).json().id as string;
    const projects = await w.page('Projects', null, other);
    expect((await req('POST', w.headers, `/api/v1/pages/${projects}/collection`)).statusCode).toBe(201);
    const list = (await req('GET', w.headers, '/api/v1/collections?q=')).json();
    expect(list.map((c: { title: string; spaceName: string }) => `${c.title} (${c.spaceName})`).sort()).toEqual([
      'Clients (Clients)',
      'Projects (Projects)',
    ]);
    expect((await req('GET', w.headers, '/api/v1/collections?q=proj')).json().map((c: { title: string }) => c.title)).toEqual(['Projects']);
  });
});
