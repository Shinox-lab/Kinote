import { describe, test, beforeAll, afterEach, afterAll, expect } from 'vitest';
import { DeterministicEmbeddingProvider } from '@kinote/core';
import { collabSettle, type CollabServer } from '../../collab/src/server.js';
import { startCollabServer } from '../../collab/test/support/wsClient.js';
import { runPendingJobsForTenant } from '../../worker/src/runner.js';
import { InProcessCollabClient } from './support/inProcessCollab.js';
import { bootstrapTenant, buildTestApp, signUpMember, useTestDb } from './support/testkit.js';

type Headers = Record<string, string>;

/** Ask answers across a collection from a table of its rows (C9). */
describe('Ask reads collections', () => {
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
    const { tenant, headers } = await bootstrapTenant(app, { name: 'Ask Co', slug: 'ask-co' });
    const space = async (name: string, slug: string) => (await req('POST', headers, '/api/v1/spaces', { name, slug })).json().id as string;
    const clientsSpace = await space('Clients', 'clients');
    const otherSpace = await space('Other', 'other');
    const page = async (spaceId: string, title: string, slug: string, markdown: string, parentId: string | null = null) => {
      const res = await req('POST', headers, '/api/v1/pages', { space_id: spaceId, parent_id: parentId, title, slug, markdown });
      expect(res.statusCode, res.body).toBe(201);
      return res.json().id as string;
    };
    const clients = await page(clientsSpace, 'Clients', 'clients', 'Our clients and when they launch.');
    expect((await req('POST', headers, `/api/v1/pages/${clients}/collection`)).statusCode).toBe(201);
    const launch = (await req('POST', headers, `/api/v1/collections/${clients}/fields`, { name: 'Launch date', type: 'date' })).json();
    const rows: Record<string, string> = {};
    for (const [title, start] of [['George', '2026-12-01'], ['Hana', '2026-12-09'], ['Ivan', '2027-03-02']] as const) {
      const id = await page(clientsSpace, title, title.toLowerCase(), `${title} is a client who launches soon.`, clients);
      expect((await req('PATCH', headers, `/api/v1/pages/${id}/fields`, { [launch.id]: { start } })).statusCode).toBe(200);
      expect((await req('POST', headers, `/api/v1/pages/${id}/snapshot`)).statusCode).toBeLessThan(300);
      rows[title] = id;
    }
    await page(otherSpace, 'Launch calendar', 'launch-calendar', 'Clients launch in December and March.');
    await run(tenant.id);
    return { tenant, headers, clientsSpace, otherSpace, clients, rows };
  }

  const ask = (headers: Headers, question: string) => req('POST', headers, '/api/v1/ask', { question });

  test('answers across a collection and cites the rows it used', async () => {
    const w = await world();
    const res = await ask(w.headers, 'which clients launch in December?');
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.foundRelevant).toBe(true);
    expect(body.answer).toContain('Table Clients');
    const cited = body.citations.map((c: { documentId: string }) => c.documentId);
    expect(cited).toEqual(expect.arrayContaining([w.rows.George, w.rows.Hana]));
    const george = body.citations.find((c: { documentId: string; quote: string }) => c.documentId === w.rows.George);
    expect(george.quote).toContain('Launch date: 2026-12-01');
  });

  test('a member who cannot read the collection space gets no table', async () => {
    const w = await world();
    const member = await signUpMember(app, w.tenant.id, 'member');
    const grant = await req('POST', w.headers, `/api/v1/spaces/${w.otherSpace}/grants`, {
      principal_type: 'user',
      principal_id: member.userId,
      role: 'viewer',
    });
    expect(grant.statusCode, grant.body).toBeLessThan(300);
    const res = await ask(member.headers, 'which clients launch in December?');
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.answer).not.toContain('Table Clients');
    expect(body.citations.every((c: { spaceId: string }) => c.spaceId !== w.clientsSpace)).toBe(true);
  });
});
