import { describe, test, beforeAll, afterEach, afterAll, expect } from 'vitest';
import { DeterministicEmbeddingProvider, DeterministicPlacementModel } from '@living-wiki/core';
import { collabSettle, type CollabServer } from '../../collab/src/server.js';
import { startCollabServer } from '../../collab/test/support/wsClient.js';
import { runPendingJobsForTenant } from '../../worker/src/runner.js';
import { InProcessCollabClient } from './support/inProcessCollab.js';
import { bootstrapTenant, buildTestApp, signUpMember, useTestDb } from './support/testkit.js';

type Headers = Record<string, string>;

const NOTE = 'Oct 14 meeting with George\n- George hero video swap.\n- Shop the look.\n- George launch moved to December.';
const TITLE = 'Oct 14 meeting with George';

describe('page connections', () => {
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

  const post = (headers: Headers, url: string, payload: unknown = {}) =>
    app.inject({ method: 'POST', url, headers, payload: payload as any });
  const get = (headers: Headers, url: string) => app.inject({ method: 'GET', url, headers });
  const run = (tenantId: string) =>
    runPendingJobsForTenant(tenantId, { collab, placementModel: model, embeddingProvider: embedder });

  async function world() {
    const { tenant, headers } = await bootstrapTenant(app, { name: 'Links Co', slug: 'links-co' });
    const space = async (name: string, slug: string) =>
      (await post(headers, '/api/v1/spaces', { name, slug })).json().id as string;
    const clients = await space('Clients', 'clients');
    const secret = await space('Secret', 'secret');
    const page = async (spaceId: string, title: string, slug: string, markdown: string, parentId: string | null = null) => {
      const res = await post(headers, '/api/v1/pages', { space_id: spaceId, parent_id: parentId, title, slug, markdown });
      expect(res.statusCode, res.body).toBe(201);
      const id = res.json().id as string;
      const snap = await post(headers, `/api/v1/pages/${id}/snapshot`);
      expect(snap.statusCode, snap.body).toBeLessThan(300);
      await run(tenant.id);
      return id;
    };
    return { tenant, headers, clients, secret, page };
  }

  async function reader(w: Awaited<ReturnType<typeof world>>) {
    const member = await signUpMember(app, w.tenant.id, 'member');
    const grant = await post(w.headers, `/api/v1/spaces/${w.clients}/grants`, {
      principal_type: 'user',
      principal_id: member.userId,
      role: 'viewer',
    });
    expect(grant.statusCode, grant.body).toBeLessThan(300);
    return member;
  }

  describe('link targets', () => {
    test('title matches come first, from readable spaces only, with the parent title', async () => {
      const w = await world();
      const george = await w.page(w.clients, 'Client - George', 'george', 'George is a client.');
      await w.page(w.clients, 'George meeting notes', 'george-notes', 'Notes.', george);
      await w.page(w.clients, 'Lunch menu', 'lunch', 'Soup.');
      await w.page(w.secret, 'George secret plan', 'secret-plan', 'Hidden.');
      const member = await reader(w);

      const res = await get(member.headers, '/api/v1/link-targets?q=george');
      expect(res.statusCode, res.body).toBe(200);
      const titles = res.json().map((t: { title: string }) => t.title);
      expect(titles).toEqual(expect.arrayContaining(['Client - George', 'George meeting notes']));
      expect(titles).not.toContain('George secret plan');
      expect(titles).not.toContain('Lunch menu');
      expect(res.json().find((t: { title: string }) => t.title === 'George meeting notes')).toMatchObject({
        spaceName: 'Clients',
        parentTitle: 'Client - George',
      });
    });

    test('an empty query lists pages, and archived pages are left out', async () => {
      const w = await world();
      const gone = await w.page(w.clients, 'Old page', 'old', 'Old.');
      await w.page(w.clients, 'Live page', 'live', 'Live.');
      expect((await post(w.headers, `/api/v1/pages/${gone}/archive`)).statusCode).toBe(200);
      const titles = (await get(w.headers, '/api/v1/link-targets')).json().map((t: { title: string }) => t.title);
      expect(titles).toContain('Live page');
      expect(titles).not.toContain('Old page');
    });
  });

  describe('titles', () => {
    test('lists readable live documents and leaves out the rest', async () => {
      const w = await world();
      const shown = await w.page(w.clients, 'Shown', 'shown', 'A.');
      const hidden = await w.page(w.secret, 'Hidden', 'hidden', 'B.');
      const member = await reader(w);
      const res = await get(member.headers, `/api/v1/documents/titles?ids=${shown},${hidden}`);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toEqual([{ id: shown, kind: 'page', title: 'Shown', icon: null }]);
    });

    test('a bad id list is a validation error', async () => {
      const w = await world();
      expect((await get(w.headers, '/api/v1/documents/titles?ids=nope')).statusCode).toBe(400);
    });
  });

  describe('connections', () => {
    test('linked from lists the linking block with its text, readable pages only', async () => {
      const w = await world();
      const target = await w.page(w.clients, 'Target', 'target', 'Target page.');
      await w.page(w.clients, 'Linker', 'linker', `Intro.\n\nSee [Target](/p/${target}) for details.`);
      await w.page(w.secret, 'Secret linker', 'secret-linker', `Also [Target](/p/${target}).`);
      const member = await reader(w);

      const res = await get(member.headers, `/api/v1/pages/${target}/connections`);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().linkedFrom).toEqual([
        expect.objectContaining({ title: 'Linker', spaceName: 'Clients', excerpt: 'See Target for details.' }),
      ]);
      const owner = (await get(w.headers, `/api/v1/pages/${target}/connections`)).json();
      expect(owner.linkedFrom.map((l: { title: string }) => l.title).sort()).toEqual(['Linker', 'Secret linker']);
    });

    test('a page the caller cannot read is not found', async () => {
      const w = await world();
      const hidden = await w.page(w.secret, 'Hidden', 'hidden', 'B.');
      const member = await reader(w);
      expect((await get(member.headers, `/api/v1/pages/${hidden}/connections`)).statusCode).toBe(404);
      expect((await get(member.headers, '/api/v1/pages/not-a-uuid/connections')).statusCode).toBe(404);
    });

    test('a document capture connects its page and the standing page both ways; undo removes it', async () => {
      const w = await world();
      const george = await w.page(w.clients, 'Client - George', 'george', 'George is a client. Launch is in November.');
      await w.page(w.clients, '29Sep', 'sep-29', 'Hero video notes.', george);
      const cap = await post(w.headers, '/api/v1/captures', { text: NOTE });
      expect(cap.statusCode, cap.body).toBe(201);
      const captureId = cap.json().id as string;
      await run(w.tenant.id);
      const detail = (await get(w.headers, `/api/v1/captures/${captureId}`)).json();
      const docPage = detail.receipt.document.pageId as string;
      expect(docPage).toBeTruthy();

      const standing = (await get(w.headers, `/api/v1/pages/${george}/connections`)).json();
      expect(standing.updatedBy).toEqual([
        expect.objectContaining({ pageId: docPage, title: TITLE, spaceName: 'Clients', blockIds: expect.any(Array) }),
      ]);
      expect(standing.updatedBy[0].blockIds.length).toBeGreaterThan(0);

      const doc = (await get(w.headers, `/api/v1/pages/${docPage}/connections`)).json();
      expect(doc.updated).toEqual([
        expect.objectContaining({ pageId: george, title: 'Client - George', captureId, sections: standing.updatedBy[0].blockIds.length }),
      ]);

      const undo = await post(w.headers, `/api/v1/captures/${captureId}/undo`);
      expect(undo.statusCode, undo.body).toBe(200);
      expect((await get(w.headers, `/api/v1/pages/${george}/connections`)).json().updatedBy).toEqual([]);
    });
  });
});
