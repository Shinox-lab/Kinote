import { describe, test, beforeAll, afterEach, afterAll, expect } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { withTenantTx, captures, suggestions, versions, spaces } from '@living-wiki/db';
import { blockText } from '@living-wiki/core';
import type { BlockLike } from '@living-wiki/shared';
import { collabSettle, type CollabServer } from '../../collab/src/server.js';
import { startCollabServer } from '../../collab/test/support/wsClient.js';
import { readBlocks } from '../../collab/test/support/blocks.js';
import { storedDoc } from '../../collab/test/support/collabWorld.js';
import { InProcessCollabClient } from './support/inProcessCollab.js';
import { bootstrapTenant, buildTestApp, signUpMember, useTestDb } from './support/testkit.js';

type Headers = Record<string, string>;

describe('suggestions', () => {
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

  const post = (headers: Headers, url: string, payload: unknown = {}) =>
    app.inject({ method: 'POST', url, headers, payload: payload as any });

  async function world() {
    const { tenant, headers } = await bootstrapTenant(app, { name: 'Suggest Co', slug: 'suggest-co' });
    const space = async (slug: string, review: boolean) =>
      (await post(headers, '/api/v1/spaces', { name: slug, slug, review_required: review })).json().id as string;
    const open = await space('open', false);
    const review = await space('review', true);
    const page = async (spaceId: string, slug: string) =>
      (await post(headers, '/api/v1/pages', { space_id: spaceId, title: slug, slug, markdown: 'Billing uses Stripe.\n\nInvoices go out monthly.' })).json()
        .id as string;
    const openPage = await page(open, 'billing');
    const reviewPage = await page(review, 'acme');
    const member = async (grants: Array<[string, string]>) => {
      const m = await signUpMember(app, tenant.id, 'member');
      for (const [spaceId, role] of grants) {
        await post(headers, `/api/v1/spaces/${spaceId}/grants`, { principal_type: 'user', principal_id: m.userId, role });
      }
      return m;
    };
    const sender = await member([[open, 'editor'], [review, 'reviewer']]);
    const editor = await member([[open, 'editor']]);
    const reviewer = await member([[review, 'reviewer']]);
    const viewer = await member([[open, 'viewer']]);
    const [capture] = await withTenantTx(tenant.id, (tx) =>
      tx
        .insert(captures)
        .values({ tenantId: tenant.id, senderType: 'user', senderId: sender.userId, channel: 'console', text: 'Billing no longer uses Stripe.', status: 'done' })
        .returning()
    );
    return { tenant, headers, open, review, openPage, reviewPage, sender, editor, reviewer, viewer, captureId: capture!.id };
  }

  async function live(tenantId: string, pageId: string): Promise<BlockLike[]> {
    return readBlocks(await storedDoc(tenantId, pageId)) as BlockLike[];
  }

  async function suggestRemoval(w: Awaited<ReturnType<typeof world>>, pageId: string, spaceId: string) {
    const block = (await live(w.tenant.id, pageId)).find((b) => blockText(b).includes('Stripe'))!;
    const [row] = await withTenantTx(w.tenant.id, (tx) =>
      tx
        .insert(suggestions)
        .values({
          tenantId: w.tenant.id, documentId: pageId, spaceId, blockId: block.id, kind: 'remove',
          reason: 'Billing no longer uses Stripe.', blockedBy: 'removal', captureId: w.captureId,
        })
        .returning()
    );
    return { id: row!.id, blockId: block.id };
  }

  const versionOf = async (tenantId: string, pageId: string) =>
    (await withTenantTx(tenantId, (tx) => tx.select().from(versions).where(eq(versions.documentId, pageId)))).sort(
      (a, b) => b.number - a.number
    )[0];

  test('an editor accepts a removal in a space with review off', async () => {
    const w = await world();
    const s = await suggestRemoval(w, w.openPage, w.open);
    const list = await app.inject({ method: 'GET', url: `/api/v1/pages/${w.openPage}/suggestions`, headers: w.viewer.headers });
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json()).toMatchObject([{ id: s.id, kind: 'remove', blockedBy: 'removal' }]);

    const res = await post(w.editor.headers, `/api/v1/suggestions/${s.id}/accept`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ id: s.id, status: 'accepted' });
    expect((await live(w.tenant.id, w.openPage)).map(blockText)).toEqual(['Invoices go out monthly.']);
    expect((await versionOf(w.tenant.id, w.openPage))!.status).toBe('indexing');
  });

  test('a reviewer accepts in a review space and the change is approved in the same request', async () => {
    const w = await world();
    const s = await suggestRemoval(w, w.reviewPage, w.review);
    const res = await post(w.reviewer.headers, `/api/v1/suggestions/${s.id}/accept`);
    expect(res.statusCode, res.body).toBe(200);
    const v = await versionOf(w.tenant.id, w.reviewPage);
    expect(v!.status).toBe('indexing');
    expect(v!.reviewedBy).toBe(w.reviewer.userId);
  });

  test("the sender cannot accept their own in a review space without self-approval", async () => {
    const w = await world();
    const s = await suggestRemoval(w, w.reviewPage, w.review);
    const res = await post(w.sender.headers, `/api/v1/suggestions/${s.id}/accept`);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('self_approval');
    await withTenantTx(w.tenant.id, (tx) =>
      tx.update(spaces).set({ allowSelfApproval: true }).where(and(eq(spaces.tenantId, w.tenant.id), eq(spaces.id, w.review)))
    );
    expect((await post(w.sender.headers, `/api/v1/suggestions/${s.id}/accept`)).statusCode).toBe(200);
  });

  test('a viewer cannot accept or decline', async () => {
    const w = await world();
    const s = await suggestRemoval(w, w.openPage, w.open);
    expect((await post(w.viewer.headers, `/api/v1/suggestions/${s.id}/accept`)).statusCode).toBe(403);
    expect((await post(w.viewer.headers, `/api/v1/suggestions/${s.id}/decline`)).statusCode).toBe(403);
  });

  test('a suggestion is decided once', async () => {
    const w = await world();
    const s = await suggestRemoval(w, w.openPage, w.open);
    const declined = await post(w.editor.headers, `/api/v1/suggestions/${s.id}/decline`);
    expect(declined.statusCode, declined.body).toBe(200);
    expect(declined.json()).toMatchObject({ status: 'declined' });
    expect((await live(w.tenant.id, w.openPage)).map(blockText)).toContain('Billing uses Stripe.');
    const again = await post(w.editor.headers, `/api/v1/suggestions/${s.id}/accept`);
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe('suggestion_not_open');
  });

  test('a suggestion whose block is gone becomes stale', async () => {
    const w = await world();
    const s = await suggestRemoval(w, w.openPage, w.open);
    await withTenantTx(w.tenant.id, (tx) =>
      tx.update(suggestions).set({ blockId: 'gone-block' }).where(eq(suggestions.id, s.id))
    );
    const res = await post(w.editor.headers, `/api/v1/suggestions/${s.id}/accept`);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('suggestion_not_open');
    const [row] = await withTenantTx(w.tenant.id, (tx) => tx.select().from(suggestions).where(eq(suggestions.id, s.id)));
    expect(row!.status).toBe('stale');
  });

  test('an unknown suggestion is 404', async () => {
    const w = await world();
    const res = await post(w.editor.headers, '/api/v1/suggestions/00000000-0000-4000-8000-000000000000/accept');
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('suggestion_not_found');
  });
});
