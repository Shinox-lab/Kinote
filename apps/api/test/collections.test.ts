import { describe, test, beforeAll, afterEach, afterAll, expect } from 'vitest';
import { and, eq, like } from 'drizzle-orm';
import { jobs, withTenantTx } from '@kinote/db';
import { FIELDS_MAP } from '@kinote/contracts';
import { DeterministicEmbeddingProvider } from '@kinote/core';
import { collabSettle, type CollabServer } from '../../collab/src/server.js';
import { startCollabServer } from '../../collab/test/support/wsClient.js';
import { storedDoc } from '../../collab/test/support/collabWorld.js';
import { runPendingJobsForTenant } from '../../worker/src/runner.js';
import { InProcessCollabClient } from './support/inProcessCollab.js';
import { bootstrapTenant, buildTestApp, signUpMember, useTestDb } from './support/testkit.js';

type Headers = Record<string, string>;

describe('collections', () => {
  let server: CollabServer;
  let collab: InProcessCollabClient;
  let app: ReturnType<typeof buildTestApp>;
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

  const req = (method: string, headers: Headers, url: string, payload?: unknown) =>
    app.inject({ method: method as any, url, headers, ...(payload !== undefined ? { payload: payload as any } : {}) });
  const run = (tenantId: string) => runPendingJobsForTenant(tenantId, { collab, embeddingProvider: embedder });

  async function world() {
    const { tenant, headers, inboxSpace, owner } = await bootstrapTenant(app, { name: 'Coll Co', slug: 'coll-co' });
    const space = (await req('POST', headers, '/api/v1/spaces', { name: 'Clients', slug: 'clients' })).json().id as string;
    const page = async (title: string, slug: string, parentId: string | null = null, spaceId = space) => {
      const res = await req('POST', headers, '/api/v1/pages', { space_id: spaceId, parent_id: parentId, title, slug, markdown: `${title} notes.` });
      expect(res.statusCode, res.body).toBe(201);
      return res.json().id as string;
    };
    const clients = await page('Clients', 'clients');
    const george = await page('George', 'george', clients);
    const deep = await page('George notes', 'george-notes', george);
    return { tenant, owner, headers, inbox: inboxSpace.id as string, space, page, clients, george, deep };
  }

  async function asCollection(headers: Headers, pageId: string) {
    const res = await req('POST', headers, `/api/v1/pages/${pageId}/collection`);
    expect(res.statusCode, res.body).toBe(201);
    return res.json();
  }
  async function addField(headers: Headers, collectionId: string, body: unknown) {
    const res = await req('POST', headers, `/api/v1/collections/${collectionId}/fields`, body);
    expect(res.statusCode, res.body).toBe(201);
    return res.json();
  }
  const details = async (headers: Headers, pageId: string) => (await req('GET', headers, `/api/v1/pages/${pageId}`)).json();
  const reindexJobs = (tenantId: string) =>
    withTenantTx(tenantId, (tx) =>
      tx
        .select({ key: jobs.idempotencyKey, status: jobs.status })
        .from(jobs)
        .where(and(eq(jobs.tenantId, tenantId), eq(jobs.queue, 'document.reindex'), like(jobs.idempotencyKey, 'reindex:%')))
    );

  test('turn a page into a collection and back', async () => {
    const w = await world();
    const created = await asCollection(w.headers, w.clients);
    expect(created).toMatchObject({ id: w.clients, title: 'Clients', fields: [] });
    expect((await req('POST', w.headers, `/api/v1/pages/${w.clients}/collection`)).statusCode).toBe(409);
    expect((await details(w.headers, w.clients)).collection).toMatchObject({ id: w.clients });
    expect((await req('GET', w.headers, `/api/v1/collections/${w.clients}`)).json()).toMatchObject({ id: w.clients });

    expect((await req('DELETE', w.headers, `/api/v1/pages/${w.clients}/collection`)).statusCode).toBe(204);
    expect((await details(w.headers, w.clients)).collection).toBeNull();
    expect((await req('GET', w.headers, `/api/v1/collections/${w.clients}`)).statusCode).toBe(404);
  });

  test('fields: add, rename, reorder, remove; names unique case-insensitively; 51st field is field_limit', async () => {
    const w = await world();
    await asCollection(w.headers, w.clients);
    const status = await addField(w.headers, w.clients, {
      name: 'Status',
      type: 'select',
      options: { choices: [{ id: 'active', name: 'Active', color: 'green' }] },
    });
    const launch = await addField(w.headers, w.clients, { name: 'Launch date', type: 'date' });
    expect(status).toMatchObject({ name: 'Status', type: 'select' });

    const taken = await req('POST', w.headers, `/api/v1/collections/${w.clients}/fields`, { name: 'status', type: 'text' });
    expect(taken.statusCode).toBe(409);
    expect(taken.json().error).toBe('field_name_taken');

    const renamed = await req('PATCH', w.headers, `/api/v1/collections/${w.clients}/fields/${launch.id}`, { name: 'Launch' });
    expect(renamed.json()).toMatchObject({ name: 'Launch' });
    // Put Launch first.
    expect((await req('PATCH', w.headers, `/api/v1/collections/${w.clients}/fields/${launch.id}`, { after: null })).statusCode).toBe(200);
    const order = (await req('GET', w.headers, `/api/v1/collections/${w.clients}`)).json().fields.map((f: { name: string }) => f.name);
    expect(order).toEqual(['Launch', 'Status']);
    // A type can't change: options of another type are refused.
    expect((await req('PATCH', w.headers, `/api/v1/collections/${w.clients}/fields/${launch.id}`, { options: { choices: [] } })).statusCode).toBe(400);

    expect((await req('DELETE', w.headers, `/api/v1/collections/${w.clients}/fields/${launch.id}`)).statusCode).toBe(204);
    expect((await req('GET', w.headers, `/api/v1/collections/${w.clients}`)).json().fields).toHaveLength(1);

    for (let i = 1; i < 50; i++) await addField(w.headers, w.clients, { name: `F${i}`, type: 'text' });
    const over = await req('POST', w.headers, `/api/v1/collections/${w.clients}/fields`, { name: 'F50', type: 'text' });
    expect(over.statusCode).toBe(400);
    expect(over.json().error).toBe('field_limit');
  });

  test('choices added at the same time are all kept', async () => {
    const w = await world();
    await asCollection(w.headers, w.clients);
    const status = await addField(w.headers, w.clients, { name: 'Status', type: 'select' });
    const url = `/api/v1/collections/${w.clients}/fields/${status.id}`;
    const added = await Promise.all(
      ['Active', 'Lead', 'Lost'].map((name) => req('PATCH', w.headers, url, { add_choice: { name, color: 'green' } }))
    );
    expect(added.map((r) => r.statusCode)).toEqual([200, 200, 200]);
    const names = (await req('GET', w.headers, `/api/v1/collections/${w.clients}`)).json().fields[0].options.choices.map((c: { name: string }) => c.name);
    expect(names.sort()).toEqual(['Active', 'Lead', 'Lost']);

    const lead = (await req('GET', w.headers, `/api/v1/collections/${w.clients}`)).json().fields[0].options.choices.find((c: { name: string }) => c.name === 'Lead');
    const removed = await req('PATCH', w.headers, url, { remove_choice: lead.id });
    expect(removed.json().options.choices.map((c: { name: string }) => c.name).sort()).toEqual(['Active', 'Lost']);
    // Adding a name that's there already returns the field unchanged.
    const again = await req('PATCH', w.headers, url, { add_choice: { name: 'active', color: 'red' } });
    expect(again.json().options.choices).toHaveLength(2);
  });

  test('no collections in the Inbox', async () => {
    const w = await world();
    const mine = await w.page('Mine', 'mine', null, w.inbox);
    const res = await req('POST', w.headers, `/api/v1/pages/${mine}/collection`);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('collection_in_inbox');
  });

  test('a viewer reads but can’t change fields or values (403)', async () => {
    const w = await world();
    await asCollection(w.headers, w.clients);
    const status = await addField(w.headers, w.clients, { name: 'Note', type: 'text' });
    const viewer = await signUpMember(app, w.tenant.id, 'member');
    await req('POST', w.headers, `/api/v1/spaces/${w.space}/grants`, { principal_type: 'user', principal_id: viewer.userId, role: 'viewer' });

    expect((await req('GET', viewer.headers, `/api/v1/collections/${w.clients}`)).statusCode).toBe(200);
    expect((await req('POST', viewer.headers, `/api/v1/collections/${w.clients}/fields`, { name: 'X', type: 'text' })).statusCode).toBe(403);
    expect((await req('DELETE', viewer.headers, `/api/v1/collections/${w.clients}/fields/${status.id}`)).statusCode).toBe(403);
    expect((await req('PATCH', viewer.headers, `/api/v1/pages/${w.george}/fields`, { [status.id]: 'hi' })).statusCode).toBe(403);
    expect((await req('DELETE', viewer.headers, `/api/v1/pages/${w.clients}/collection`)).statusCode).toBe(403);
  });

  test('PATCH values: valid ones stored, wrong shape is field_invalid_value, null clears', async () => {
    const w = await world();
    await asCollection(w.headers, w.clients);
    const status = await addField(w.headers, w.clients, {
      name: 'Status',
      type: 'select',
      options: { choices: [{ id: 'active', name: 'Active', color: 'green' }] },
    });
    const launch = await addField(w.headers, w.clients, { name: 'Launch date', type: 'date' });

    const ok = await req('PATCH', w.headers, `/api/v1/pages/${w.george}/fields`, { [status.id]: 'active', [launch.id]: { start: '2026-12-01' } });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().fields).toEqual({ [status.id]: 'active', [launch.id]: { start: '2026-12-01' } });
    expect((await storedDoc(w.tenant.id, w.george)).getMap(FIELDS_MAP).get(status.id)).toBe('active');

    const bad = await req('PATCH', w.headers, `/api/v1/pages/${w.george}/fields`, { [launch.id]: 'December' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe('field_invalid_value');
    const unknown = await req('PATCH', w.headers, `/api/v1/pages/${w.george}/fields`, { '44444444-4444-4444-8444-444444444444': 'x' });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error).toBe('field_not_found');
    // A grandchild is not a row.
    expect((await req('PATCH', w.headers, `/api/v1/pages/${w.deep}/fields`, { [status.id]: 'active' })).statusCode).toBe(404);

    const cleared = await req('PATCH', w.headers, `/api/v1/pages/${w.george}/fields`, { [status.id]: null });
    expect(cleared.json().fields).toEqual({ [launch.id]: { start: '2026-12-01' } });
  });

  test('a sub-page shows rowOf; a grandchild doesn’t', async () => {
    const w = await world();
    await asCollection(w.headers, w.clients);
    await addField(w.headers, w.clients, { name: 'Note', type: 'text' });
    expect((await details(w.headers, w.george)).rowOf).toMatchObject({ id: w.clients, fields: [{ name: 'Note' }] });
    expect((await details(w.headers, w.deep)).rowOf).toBeNull();
    expect((await details(w.headers, w.george)).collection).toBeNull();
  });

  test('removing a choice or a field, and moving a row out, re-index the rows', async () => {
    const w = await world();
    expect((await req('POST', w.headers, `/api/v1/pages/${w.george}/snapshot`)).statusCode).toBeLessThan(300);
    await run(w.tenant.id);
    await asCollection(w.headers, w.clients);
    const status = await addField(w.headers, w.clients, {
      name: 'Status',
      type: 'select',
      options: { choices: [{ id: 'active', name: 'Active', color: 'green' }, { id: 'lead', name: 'Lead', color: 'gray' }] },
    });
    await req('PATCH', w.headers, `/api/v1/pages/${w.george}/fields`, { [status.id]: 'lead' });
    expect((await req('GET', w.headers, `/api/v1/collections/${w.clients}/fields/${status.id}/usage`)).json()).toEqual({ pages: 1 });

    const patched = await req('PATCH', w.headers, `/api/v1/collections/${w.clients}/fields/${status.id}`, {
      options: { choices: [{ id: 'active', name: 'Active', color: 'green' }] },
    });
    expect(patched.statusCode, patched.body).toBe(200);
    expect(await reindexJobs(w.tenant.id)).toEqual([{ key: `reindex:${w.george}`, status: 'queued' }]);
    await run(w.tenant.id);
    expect((await reindexJobs(w.tenant.id))[0]!.status).toBe('completed');

    const moved = await req('POST', w.headers, `/api/v1/pages/${w.george}/move`, { target_space_id: w.space, target_parent_id: null });
    expect(moved.statusCode, moved.body).toBe(200);
    expect((await reindexJobs(w.tenant.id))[0]!.status).toBe('queued');
  });
});
