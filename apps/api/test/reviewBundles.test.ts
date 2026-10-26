import { describe, test, expect } from 'vitest';
import { withTenantTx, captureChanges, captureFacts, captures, suggestions } from '@living-wiki/db';
import { bootstrapTenant, buildTestApp, signUpMember, useTestDb } from './support/testkit.js';

type Headers = Record<string, string>;

describe('review bundles and per-capture changes', () => {
  const app = buildTestApp();
  useTestDb();

  const post = (headers: Headers, url: string, payload: unknown = {}) =>
    app.inject({ method: 'POST', url, headers, payload: payload as any });
  const get = (headers: Headers, url: string) => app.inject({ method: 'GET', url, headers });

  async function world() {
    const { tenant, owner, headers } = await bootstrapTenant(app, { name: 'Bundle Co', slug: 'bundle-co' });
    const space = async (slug: string, review: boolean) =>
      (await post(headers, '/api/v1/spaces', { name: slug, slug, review_required: review })).json().id as string;
    const review = await space('review', true);
    const hidden = await space('hidden', false);
    const page = async (spaceId: string, slug: string) =>
      (await post(headers, '/api/v1/pages', { space_id: spaceId, title: `Page ${slug}`, slug, markdown: `Text of ${slug}.` })).json()
        .id as string;
    const a = await page(review, 'a');
    const b = await page(review, 'b');
    const lone = await page(review, 'lone');
    const secret = await page(hidden, 'secret');
    const versionOf = async (pageId: string) => {
      const res = await post(headers, `/api/v1/pages/${pageId}/snapshot`);
      expect(res.statusCode, res.body).toBe(201);
      return res.json().id as string;
    };
    // Order of waiting: a, lone, b. a and b come from one capture.
    const va = await versionOf(a);
    const vlone = await versionOf(lone);
    const vb = await versionOf(b);
    const vsecret = await versionOf(secret);
    const reviewer = await signUpMember(app, tenant.id, 'member');
    await post(headers, `/api/v1/spaces/${review}/grants`, { principal_type: 'user', principal_id: reviewer.userId, role: 'reviewer' });

    const captureId = await withTenantTx(tenant.id, async (tx) => {
      const [capture] = await tx
        .insert(captures)
        .values({ tenantId: tenant.id, senderType: 'user', senderId: owner.userId, channel: 'console', text: 'x'.repeat(300), status: 'done' })
        .returning();
      const [fact] = await tx
        .insert(captureFacts)
        .values({ tenantId: tenant.id, captureId: capture!.id, ordinal: 0, statement: 's', kind: 'change', outcome: 'waiting_review', reason: 'r' })
        .returning();
      for (const [documentId, spaceId, versionId] of [
        [a, review, va],
        [b, review, vb],
        [secret, hidden, vsecret],
      ] as const) {
        await tx.insert(captureChanges).values({
          tenantId: tenant.id, captureId: capture!.id, factId: fact!.id, documentId, spaceId, blockId: `blk-${documentId}`,
          op: 'replace', beforeMarkdown: 'before', afterMarkdown: 'after', versionId,
        });
      }
      await tx.insert(suggestions).values({
        tenantId: tenant.id, documentId: a, spaceId: review, blockId: 'blk-x', kind: 'remove', reason: 'gone', blockedBy: 'removal',
        captureId: capture!.id, factId: fact!.id,
      });
      return capture!.id;
    });
    return { tenant, owner, headers, reviewer, review, a, b, lone, secret, captureId };
  }

  test('pages waiting from one capture come back together, with the capture and its suggestions', async () => {
    const w = await world();
    const res = await get(w.reviewer.headers, '/api/v1/reviews');
    expect(res.statusCode, res.body).toBe(200);
    const items = res.json() as Array<{ document: { id: string }; capture: any; suggestions: any[] }>;
    expect(items.map((i) => i.document.id)).toEqual([w.a, w.b, w.lone]);
    expect(items[0]!.capture).toMatchObject({ id: w.captureId, excerpt: 'x'.repeat(280) });
    expect(items[1]!.capture.id).toBe(w.captureId);
    expect(items[2]!.capture).toBeNull();
    expect(items[0]!.suggestions).toMatchObject([{ kind: 'remove', blockedBy: 'removal' }]);
    expect(items[1]!.suggestions).toEqual([]);
  });

  test('alsoApplied lists only pages the reviewer can read', async () => {
    const w = await world();
    const items = (await get(w.reviewer.headers, '/api/v1/reviews')).json();
    expect(items[0].capture.alsoApplied.map((p: { pageId: string }) => p.pageId)).toEqual([w.b]);
    const asOwner = (await get(w.headers, '/api/v1/reviews')).json();
    expect(asOwner[0].capture.alsoApplied.map((p: { pageId: string }) => p.pageId).sort()).toEqual([w.b, w.secret].sort());
  });

  test("a page's capture changes list only that page's changes", async () => {
    const w = await world();
    const res = await get(w.reviewer.headers, `/api/v1/pages/${w.a}/capture-changes?capture=${w.captureId}`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject([{ documentId: w.a, blockId: `blk-${w.a}`, beforeMarkdown: 'before', afterMarkdown: 'after' }]);
  });

  test('a non-reader gets 404 for capture changes', async () => {
    const w = await world();
    const res = await get(w.reviewer.headers, `/api/v1/pages/${w.secret}/capture-changes?capture=${w.captureId}`);
    expect(res.statusCode).toBe(404);
  });
});
