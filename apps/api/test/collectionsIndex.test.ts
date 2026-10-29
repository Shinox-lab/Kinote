import { describe, test, beforeAll, afterEach, afterAll, expect } from 'vitest';
import { and, asc, eq } from 'drizzle-orm';
import { chunks, withTenantTx } from '@living-wiki/db';
import { FIELDS_MAP } from '@living-wiki/contracts';
import { DeterministicEmbeddingProvider } from '@living-wiki/core';
import { collabSettle, type CollabServer } from '../../collab/src/server.js';
import { startCollabServer } from '../../collab/test/support/wsClient.js';
import { storedDoc } from '../../collab/test/support/collabWorld.js';
import { runPendingJobsForTenant } from '../../worker/src/runner.js';
import { InProcessCollabClient } from './support/inProcessCollab.js';
import { bootstrapTenant, buildTestApp, signUpMember, useTestDb } from './support/testkit.js';

type Headers = Record<string, string>;

/** Field values in Search, diffs, history and restore (C3, C9). */
describe('collection fields in the index', () => {
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

  async function world(reviewRequired = false) {
    const { tenant, headers, owner } = await bootstrapTenant(app, { name: 'Idx Co', slug: 'idx-co' });
    const space = (await req('POST', headers, '/api/v1/spaces', { name: 'Clients', slug: 'clients', review_required: reviewRequired })).json().id as string;
    const page = async (title: string, slug: string, parentId: string | null = null, markdown = `${title} notes.`) => {
      const res = await req('POST', headers, '/api/v1/pages', { space_id: space, parent_id: parentId, title, slug, markdown });
      expect(res.statusCode, res.body).toBe(201);
      return res.json().id as string;
    };
    const clients = await page('Clients', 'clients');
    const george = await page('George', 'george', clients, 'George is a client.');
    expect((await req('POST', headers, `/api/v1/pages/${clients}/collection`)).statusCode).toBe(201);
    const field = async (body: unknown) => (await req('POST', headers, `/api/v1/collections/${clients}/fields`, body)).json();
    const status = await field({
      name: 'Status',
      type: 'select',
      options: { choices: [{ id: 'active', name: 'Active', color: 'green' }, { id: 'lead', name: 'Prospect', color: 'gray' }] },
    });
    const launch = await field({ name: 'Launch date', type: 'date' });
    return { tenant, owner, headers, space, page, clients, george, status, launch };
  }

  const setFields = async (headers: Headers, pageId: string, values: Record<string, unknown>) => {
    const res = await req('PATCH', headers, `/api/v1/pages/${pageId}/fields`, values);
    expect(res.statusCode, res.body).toBe(200);
  };
  const snapshot = async (headers: Headers, pageId: string) => {
    const res = await req('POST', headers, `/api/v1/pages/${pageId}/snapshot`);
    expect(res.statusCode, res.body).toBeLessThan(300);
    return res.json();
  };
  const chunkTexts = (tenantId: string, pageId: string) =>
    withTenantTx(tenantId, async (tx) =>
      (
        await tx
          .select({ text: chunks.text })
          .from(chunks)
          .where(and(eq(chunks.tenantId, tenantId), eq(chunks.documentId, pageId)))
          .orderBy(asc(chunks.ordinal))
      ).map((c) => c.text)
    );
  const found = async (headers: Headers, query: string, pageId: string) => {
    const res = await req('POST', headers, '/api/v1/search', { query });
    expect(res.statusCode, res.body).toBe(200);
    // The stand-in embedder ranks every passage, so a hit is one whose text has the word.
    return (res.json().passages as Array<{ documentId: string; text: string }>).some((p) => p.documentId === pageId && p.text.includes(query));
  };

  test('a row’s first chunk starts with its field lines and Search finds "December"', async () => {
    const w = await world();
    await setFields(w.headers, w.george, { [w.status.id]: 'active', [w.launch.id]: { start: '2026-12-01' } });
    await snapshot(w.headers, w.george);
    await run(w.tenant.id);
    const [first] = await chunkTexts(w.tenant.id, w.george);
    expect(first).toBe('# George\n\nStatus: Active\nLaunch date: 2026-12-01 (1 December 2026)\n\nGeorge is a client.');
    expect(await found(w.headers, 'December', w.george)).toBe(true);
  });

  test('a row with only fields is indexed from its fields', async () => {
    const w = await world();
    const empty = await w.page('Tavros', 'tavros', w.clients, '');
    await setFields(w.headers, empty, { [w.status.id]: 'lead' });
    await snapshot(w.headers, empty);
    await run(w.tenant.id);
    expect(await chunkTexts(w.tenant.id, empty)).toEqual(['# Tavros\n\nStatus: Prospect']);
  });

  test('a review space keeps the approved value in Search until approval', async () => {
    const w = await world(true);
    const reviewer = await signUpMember(app, w.tenant.id, 'member');
    await req('POST', w.headers, `/api/v1/spaces/${w.space}/grants`, { principal_type: 'user', principal_id: reviewer.userId, role: 'reviewer' });
    await setFields(w.headers, w.george, { [w.status.id]: 'lead' });
    const first = await snapshot(w.headers, w.george);
    expect((await req('POST', reviewer.headers, `/api/v1/versions/${first.id}/approve`, {})).statusCode).toBe(200);
    await run(w.tenant.id);
    expect(await found(w.headers, 'Prospect', w.george)).toBe(true);

    await setFields(w.headers, w.george, { [w.status.id]: 'active' });
    const second = await snapshot(w.headers, w.george);
    await run(w.tenant.id);
    expect((await chunkTexts(w.tenant.id, w.george))[0]).toContain('Status: Prospect');
    expect((await req('POST', reviewer.headers, `/api/v1/versions/${second.id}/approve`, {})).statusCode).toBe(200);
    await run(w.tenant.id);
    expect((await chunkTexts(w.tenant.id, w.george))[0]).toContain('Status: Active');
  });

  test('removing a choice re-indexes rows and Search no longer finds its name', async () => {
    const w = await world();
    await setFields(w.headers, w.george, { [w.status.id]: 'lead' });
    await snapshot(w.headers, w.george);
    await run(w.tenant.id);
    expect(await found(w.headers, 'Prospect', w.george)).toBe(true);
    const patched = await req('PATCH', w.headers, `/api/v1/collections/${w.clients}/fields/${w.status.id}`, {
      options: { choices: [{ id: 'active', name: 'Active', color: 'green' }] },
    });
    expect(patched.statusCode, patched.body).toBe(200);
    await run(w.tenant.id);
    expect((await chunkTexts(w.tenant.id, w.george))[0]).not.toContain('Prospect');
    expect(await found(w.headers, 'Prospect', w.george)).toBe(false);
  });

  test('moving a row out of its collection drops its header from Search', async () => {
    const w = await world();
    await setFields(w.headers, w.george, { [w.launch.id]: { start: '2026-12-01' } });
    await snapshot(w.headers, w.george);
    await run(w.tenant.id);
    const moved = await req('POST', w.headers, `/api/v1/pages/${w.george}/move`, { target_space_id: w.space, target_parent_id: null });
    expect(moved.statusCode, moved.body).toBe(200);
    await run(w.tenant.id);
    expect((await chunkTexts(w.tenant.id, w.george))[0]).toBe('# George\n\nGeorge is a client.');
  });

  test('the changes diff shows "Status: Prospect" → "Status: Active" as changed', async () => {
    const w = await world();
    await setFields(w.headers, w.george, { [w.status.id]: 'lead' });
    await snapshot(w.headers, w.george);
    await run(w.tenant.id);
    await setFields(w.headers, w.george, { [w.status.id]: 'active', [w.launch.id]: { start: '2026-12-01' } });
    const diff = (await req('GET', w.headers, `/api/v1/pages/${w.george}/changes`)).json() as Array<{ blockId: string; change: string; before?: string; after?: string }>;
    const status = diff.find((e) => e.blockId === `field:${w.status.id}`);
    expect(status).toMatchObject({ change: 'changed', before: 'Status: Prospect', after: 'Status: Active' });
    expect(diff.find((e) => e.blockId === `field:${w.launch.id}`)).toMatchObject({ change: 'added' });
  });

  test('restore brings back fields; removed ones stay hidden', async () => {
    const w = await world();
    await setFields(w.headers, w.george, { [w.status.id]: 'lead', [w.launch.id]: { start: '2026-12-01' } });
    const v1 = await snapshot(w.headers, w.george);
    await run(w.tenant.id);
    await setFields(w.headers, w.george, { [w.status.id]: 'active', [w.launch.id]: null });
    await snapshot(w.headers, w.george);
    await run(w.tenant.id);
    expect((await req('DELETE', w.headers, `/api/v1/collections/${w.clients}/fields/${w.launch.id}`)).statusCode).toBe(204);

    const restored = await req('POST', w.headers, `/api/v1/pages/${w.george}/versions/${v1.number}/restore`);
    expect(restored.statusCode, restored.body).toBeLessThan(300);
    expect((await storedDoc(w.tenant.id, w.george)).getMap(FIELDS_MAP).toJSON()).toEqual({
      [w.status.id]: 'lead',
      [w.launch.id]: { start: '2026-12-01' },
    });
    // The removed field's value came back but shows nowhere.
    const values = (await req('PATCH', w.headers, `/api/v1/pages/${w.george}/fields`, {})).json().fields;
    expect(values).toEqual({ [w.status.id]: 'lead' });
    await run(w.tenant.id);
    expect((await chunkTexts(w.tenant.id, w.george))[0]).not.toContain('Launch');
  });
});
