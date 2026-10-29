import { describe, test, expect } from 'vitest';
import { createHash } from 'node:crypto';
import * as Y from 'yjs';
import { and, eq } from 'drizzle-orm';
import { pages, withTenantTx } from '@kinote/db';
import { DRAWINGS_MAP, type DrawingElement } from '@kinote/contracts';
import { createServerEditor } from '@kinote/shared';
import { takePageSnapshot } from '../src/index.js';
import { runPendingJobsForTenant } from '../../../apps/worker/src/runner.js';
import { buildTestApp, bootstrapTenant, useTestDb } from '../../../apps/api/test/support/testkit.js';

type Headers = Record<string, string>;
const editor = createServerEditor();
const el = (id: string, over: Partial<DrawingElement> = {}): DrawingElement => ({ id, index: `a${id}`, version: 1, versionNonce: 1, type: 'rectangle', x: 0, ...over });
const drawingBlock = (id: string, drawingId: string, title = 'Flow') => ({ id, type: 'drawing', props: { drawingId, title }, children: [] });
const paragraph = (id: string, text: string) => ({ id, type: 'paragraph', content: text, children: [] });

/** Drawings ride in the page document and into its versions (D6, D7). */
describe('snapshots carry drawings', () => {
  const app = buildTestApp();
  useTestDb();

  async function world(reviewRequired = false) {
    const { tenant, owner, headers } = await bootstrapTenant(app, { name: 'Draw Co', slug: 'draw-co' });
    const space = (await app.inject({ method: 'POST', url: '/api/v1/spaces', headers, payload: { name: 'Eng', slug: 'eng', review_required: reviewRequired, allow_self_approval: true } })).json();
    const res = await app.inject({ method: 'POST', url: '/api/v1/pages', headers, payload: { space_id: space.id, title: 'Payments', slug: 'payments', markdown: 'How payments work.' } });
    expect(res.statusCode, res.body).toBe(201);
    return { tenant, owner, headers: headers as Headers, spaceId: space.id as string, page: res.json().id as string };
  }

  /** Makes the stored live page hold `blocks` and these drawing scenes (tombstones included as given). */
  async function setLive(tenantId: string, pageId: string, blocks: unknown[], drawings: Record<string, DrawingElement[]>) {
    const doc = editor.blocksToYDoc(blocks as any, 'document-store');
    doc.getMap('meta').set('title', 'Payments');
    const root = doc.getMap<Y.Map<unknown>>(DRAWINGS_MAP);
    for (const [drawingId, elements] of Object.entries(drawings)) {
      const scene = new Y.Map<unknown>();
      root.set(drawingId, scene);
      for (const e of elements) scene.set(e.id, e);
    }
    await withTenantTx(tenantId, (tx) =>
      tx
        .update(pages)
        .set({ ydocState: Buffer.from(Y.encodeStateAsUpdate(doc)), liveChangedSinceSnapshot: true })
        .where(and(eq(pages.tenantId, tenantId), eq(pages.documentId, pageId)))
    );
  }

  const snap = (w: Awaited<ReturnType<typeof world>>, manual = true) =>
    takePageSnapshot({ tenantId: w.tenant.id, pageId: w.page, reason: 'submit', actorType: 'user', actorId: w.owner.userId, manual });

  const words = [el('t1', { index: 'a1', type: 'text', text: 'Payment flow' }), el('r1', { index: 'a2' }), el('t2', { index: 'a3', type: 'text', text: 'Refund' })];

  test('a snapshot stores referenced drawings and their words', async () => {
    const w = await world();
    await setLive(w.tenant.id, w.page, [paragraph('p1', 'Intro'), drawingBlock('d1', 'g1')], {
      g1: [...words, el('gone', { isDeleted: true })],
    });
    const v = (await snap(w))!;
    expect(v.drawings).toEqual({ g1: words });
    expect(v.markdown).toContain('Drawing: Flow');
    expect(v.markdown).toContain('Payment flow');
    expect(v.markdown).toContain('Refund');
    const block = (v.blocks as any[]).find((b) => b.id === 'd1');
    expect(block.props.text).toBe('Drawing: Flow\nPayment flow\nRefund');
  });

  test('moving a shape makes a new version', async () => {
    const w = await world();
    const blocks = [drawingBlock('d1', 'g1')];
    await setLive(w.tenant.id, w.page, blocks, { g1: words });
    const first = (await snap(w))!;
    await setLive(w.tenant.id, w.page, blocks, { g1: [words[0]!, el('r1', { index: 'a2', x: 40, version: 2 }), words[2]!] });
    const second = (await snap(w))!;
    expect(second.id).not.toBe(first.id);
    expect(second.markdown).toBe(first.markdown);
  });

  test('a page without drawings hashes as before', async () => {
    const w = await world();
    await setLive(w.tenant.id, w.page, [paragraph('p1', 'Plain text')], {});
    const v = (await snap(w))!;
    expect(v.drawings).toBeNull();
    expect(v.contentHash).toBe(createHash('sha256').update(`# Payments\n\n${v.markdown}`, 'utf8').digest('hex'));
  });

  test('a page whose only content is a drawing is snapshotted', async () => {
    const w = await world();
    await setLive(w.tenant.id, w.page, [drawingBlock('d1', 'g1', '')], { g1: [el('r1')] });
    const v = (await snap(w, false))!;
    expect(v).not.toBeNull();
    expect(v.drawings).toEqual({ g1: [el('r1')] });
    expect(v.markdown).toContain('Drawing: Untitled drawing');
  });

  test('an unreferenced scene is not versioned', async () => {
    const w = await world();
    await setLive(w.tenant.id, w.page, [drawingBlock('d1', 'g1')], { g1: [el('r1')], orphan: [el('x')] });
    const v = (await snap(w))!;
    expect(Object.keys(v.drawings as object)).toEqual(['g1']);
  });

  test('in a review space a drawing-only page waits, and search finds its words only after approval', async () => {
    const w = await world(true);
    await setLive(w.tenant.id, w.page, [drawingBlock('d1', 'g1')], { g1: [el('t1', { type: 'text', text: 'Zebracorn ledger' })] });
    const v = (await snap(w))!;
    expect(v.status).toBe('pending_review');
    const search = async () =>
      (await app.inject({ method: 'POST', url: '/api/v1/search', headers: w.headers, payload: { query: 'Zebracorn ledger' } })).json().passages as Array<{
        documentId: string;
        text: string;
      }>;
    await runPendingJobsForTenant(w.tenant.id);
    expect((await search()).some((p) => p.text.includes('Zebracorn'))).toBe(false);
    const approved = await app.inject({ method: 'POST', url: `/api/v1/versions/${v.id}/approve`, headers: w.headers, payload: {} });
    expect(approved.statusCode, approved.body).toBe(200);
    await runPendingJobsForTenant(w.tenant.id);
    expect((await search()).some((p) => p.documentId === w.page && p.text.includes('Zebracorn ledger'))).toBe(true);
  });
});
