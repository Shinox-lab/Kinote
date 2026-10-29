import { describe, test, beforeAll, afterEach, afterAll, expect } from 'vitest';
import * as Y from 'yjs';
import { and, eq } from 'drizzle-orm';
import { pages, withTenantTx } from '@kinote/db';
import { DRAWINGS_MAP, type DrawingElement } from '@kinote/contracts';
import { createServerEditor } from '@kinote/shared';
import { collabSettle, type CollabServer } from '../../collab/src/server.js';
import { startCollabServer } from '../../collab/test/support/wsClient.js';
import { runPendingJobsForTenant } from '../../worker/src/runner.js';
import { InProcessCollabClient } from './support/inProcessCollab.js';
import { bootstrapTenant, buildTestApp, signUpMember, useTestDb } from './support/testkit.js';

type Headers = Record<string, string>;
const editor = createServerEditor();
const el = (id: string, over: Partial<DrawingElement> = {}): DrawingElement => ({ id, index: `a${id}`, version: 1, versionNonce: 1, type: 'rectangle', x: 0, ...over });

/** Drawing scenes over the API, and drawings in diffs (D8). */
describe('drawings over the API', () => {
  let server: CollabServer;
  let app: ReturnType<typeof buildTestApp>;

  beforeAll(async () => {
    ({ server } = await startCollabServer(undefined, { debounceMs: 60_000, maxDebounceMs: 60_000 }));
    app = buildTestApp({ collab: new InProcessCollabClient(server) });
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
    const { tenant, headers } = await bootstrapTenant(app, { name: 'Draw API Co', slug: 'draw-api-co' });
    const space = (await req('POST', headers, '/api/v1/spaces', { name: 'Eng', slug: 'eng' })).json().id as string;
    const page = (await req('POST', headers, '/api/v1/pages', { space_id: space, title: 'Flows', slug: 'flows', markdown: 'Intro.' })).json().id as string;
    return { tenant, headers, space, page };
  }

  async function setLive(tenantId: string, pageId: string, elements: DrawingElement[]) {
    const doc = editor.blocksToYDoc([{ id: 'd1', type: 'drawing', props: { drawingId: 'g1', title: 'Flow' }, children: [] }] as any, 'document-store');
    doc.getMap('meta').set('title', 'Flows');
    const scene = new Y.Map<unknown>();
    doc.getMap<Y.Map<unknown>>(DRAWINGS_MAP).set('g1', scene);
    for (const e of elements) scene.set(e.id, e);
    await withTenantTx(tenantId, (tx) =>
      tx
        .update(pages)
        .set({ ydocState: Buffer.from(Y.encodeStateAsUpdate(doc)), liveChangedSinceSnapshot: true })
        .where(and(eq(pages.tenantId, tenantId), eq(pages.documentId, pageId)))
    );
  }
  const snapshot = async (w: Awaited<ReturnType<typeof world>>) => {
    const res = await req('POST', w.headers, `/api/v1/pages/${w.page}/snapshot`);
    expect(res.statusCode, res.body).toBeLessThan(300);
    return res.json();
  };

  test('a viewer reads a drawing of a version and the live one', async () => {
    const w = await world();
    await setLive(w.tenant.id, w.page, [el('A')]);
    await snapshot(w);
    await setLive(w.tenant.id, w.page, [el('A', { x: 5, version: 2 }), el('B'), el('gone', { isDeleted: true })]);
    const viewer = await signUpMember(app, w.tenant.id, 'member');
    await req('POST', w.headers, `/api/v1/spaces/${w.space}/grants`, { principal_type: 'user', principal_id: viewer.userId, role: 'viewer' });
    const v1 = await req('GET', viewer.headers, `/api/v1/pages/${w.page}/drawings/g1?version=1`);
    expect(v1.statusCode, v1.body).toBe(200);
    expect(v1.json()).toEqual({ elements: [el('A')] });
    const live = await req('GET', viewer.headers, `/api/v1/pages/${w.page}/drawings/g1`);
    expect(live.json().elements.map((e: DrawingElement) => e.id)).toEqual(['A', 'B']);
  });

  test('another tenant gets 404', async () => {
    const w = await world();
    await setLive(w.tenant.id, w.page, [el('A')]);
    const other = await bootstrapTenant(app, { name: 'Other Co', slug: 'other-co' });
    const res = await req('GET', other.headers, `/api/v1/pages/${w.page}/drawings/g1`);
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'page_not_found' });
  });

  test('an unknown drawing is block_not_found', async () => {
    const w = await world();
    await setLive(w.tenant.id, w.page, [el('A')]);
    await snapshot(w);
    for (const url of [`/api/v1/pages/${w.page}/drawings/nope`, `/api/v1/pages/${w.page}/drawings/nope?version=1`]) {
      const res = await req('GET', w.headers, url);
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ error: 'block_not_found' });
    }
    expect((await req('GET', w.headers, `/api/v1/pages/${w.page}/drawings/g1?version=9`)).json()).toMatchObject({ error: 'version_not_found' });
  });

  test('moving a shape shows the drawing block as changed with counts', async () => {
    const w = await world();
    await setLive(w.tenant.id, w.page, [el('A'), el('B')]);
    await snapshot(w);
    await setLive(w.tenant.id, w.page, [el('A', { x: 40, version: 2 }), el('B')]);
    await snapshot(w);
    await runPendingJobsForTenant(w.tenant.id);
    const diff = (await req('GET', w.headers, `/api/v1/pages/${w.page}/compare?from=1&to=2`)).json();
    expect(diff.find((e: { blockId: string }) => e.blockId === 'd1')).toMatchObject({
      change: 'changed',
      type: 'drawing',
      drawing: { drawingId: 'g1', added: 0, changed: 1, removed: 0 },
    });
    // The live changes view reads the live scene the same way.
    await setLive(w.tenant.id, w.page, [el('A', { x: 40, version: 2 }), el('B'), el('C')]);
    const changes = (await req('GET', w.headers, `/api/v1/pages/${w.page}/changes`)).json();
    expect(changes.find((e: { blockId: string }) => e.blockId === 'd1')).toMatchObject({
      change: 'changed',
      drawing: { added: 1, changed: 0, removed: 0 },
    });
  });
});
