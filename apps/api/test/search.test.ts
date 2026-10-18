import { describe, test, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import { and, eq } from 'drizzle-orm';
import { withTenantTx, chunks, rowsOf } from '@living-wiki/db';
import { sql } from 'drizzle-orm';
import { runPendingJobsForTenant } from '../../worker/src/runner.js';
import { buildTestApp, bootstrapTenant, signUpMember, useTestDb } from './support/testkit.js';

type Headers = Record<string, string>;

/**
 * Search filters on the chunk row: the Inbox is the one space with per-item
 * visibility (tenant admins see every item, everyone else only what they
 * created), carried on `chunks.inbox_owner` so the ranking reads `chunks` alone.
 * Moving a page in or out of the Inbox changes who can find it at once.
 */
describe('search: Inbox ownership on the chunk row', () => {
  const app = buildTestApp();
  useTestDb();

  let ctx: Awaited<ReturnType<typeof setup>>;

  async function createSpace(headers: Headers, slug: string) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/spaces',
      headers,
      payload: { name: slug, slug, review_required: false },
    });
    assert.equal(res.statusCode, 201, res.body);
    return res.json() as { id: string };
  }

  async function grant(headers: Headers, spaceId: string, userId: string, role: string) {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/spaces/${spaceId}/grants`,
      headers,
      payload: { principal_type: 'user', principal_id: userId, role },
    });
    assert.equal(res.statusCode, 201, res.body);
  }

  async function setup() {
    const { tenant, inboxSpace, headers: ownerHeaders } = await bootstrapTenant(app, {
      name: 'Search Co',
      slug: 'search-co',
    });
    const open = await createSpace(ownerHeaders, 'open');
    // a: the uploader. b: a different member. admin: a tenant admin (not the owner).
    const a = await signUpMember(app, tenant.id, 'member');
    const b = await signUpMember(app, tenant.id, 'member');
    const admin = await signUpMember(app, tenant.id, 'admin');
    await grant(ownerHeaders, open.id, a.userId, 'editor');
    await grant(ownerHeaders, open.id, b.userId, 'viewer');
    return { tenant, inboxSpace, ownerHeaders, open, a, b, admin };
  }

  beforeEach(async () => {
    ctx = await setup();
  });

  const BODY = 'Wombats keep the server room tidy every Thursday.';
  const QUERY = 'wombats server room';

  /** Creates a page, snapshots it (no review in these spaces) and runs the index job. */
  async function indexedPage(headers: Headers, spaceId: string, slug: string): Promise<string> {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/pages',
      headers,
      payload: { space_id: spaceId, title: `Page ${slug}`, slug, markdown: BODY, parent_id: null },
    });
    assert.equal(created.statusCode, 201, created.body);
    const pageId = created.json().document.id as string;
    const snap = await app.inject({ method: 'POST', url: `/api/v1/pages/${pageId}/snapshot`, headers });
    assert.equal(snap.statusCode, 201, snap.body);
    assert.equal(snap.json().status, 'indexing');
    await runPendingJobsForTenant(ctx.tenant.id);
    return pageId;
  }

  async function searchHits(headers: Headers, pageId: string) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/search',
      headers,
      payload: { query: QUERY },
    });
    assert.equal(res.statusCode, 200, res.body);
    return (res.json().passages as Array<{ documentId: string; citeAs: string }>).filter(
      (p) => p.documentId === pageId
    );
  }

  async function askCites(headers: Headers, pageId: string) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/ask',
      headers,
      payload: { question: QUERY },
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as { citations?: Array<{ documentId?: string }> };
    return JSON.stringify(body).includes(pageId);
  }

  /** `chunks.inbox_owner` of every chunk of the page, read with plain SQL. */
  async function inboxOwners(pageId: string): Promise<Array<string | null>> {
    const result = await withTenantTx(ctx.tenant.id, (tx) =>
      tx.execute(sql`
        SELECT inbox_owner FROM chunks
        WHERE tenant_id = ${ctx.tenant.id}::uuid AND document_id = ${pageId}::uuid
      `)
    );
    return rowsOf<{ inbox_owner: string | null }>(result).map((r) => r.inbox_owner);
  }

  async function chunkSpaces(pageId: string): Promise<string[]> {
    const rows = await withTenantTx(ctx.tenant.id, (tx) =>
      tx
        .select({ spaceId: chunks.spaceId })
        .from(chunks)
        .where(and(eq(chunks.tenantId, ctx.tenant.id), eq(chunks.documentId, pageId)))
    );
    return rows.map((r) => r.spaceId);
  }

  function move(headers: Headers, pageId: string, targetSpaceId: string) {
    return app.inject({
      method: 'POST',
      url: `/api/v1/pages/${pageId}/move`,
      headers,
      payload: { target_space_id: targetSpaceId, target_parent_id: null, position: 'a0' },
    });
  }

  test("A's Inbox page is found by A, a tenant admin and the owner, not by member B", async () => {
    const pageId = await indexedPage(ctx.a.headers, ctx.inboxSpace.id, 'inbox-a');

    const owners = await inboxOwners(pageId);
    assert.ok(owners.length > 0);
    assert.deepEqual(new Set(owners), new Set([`user:${ctx.a.userId}`]));

    const hitsA = await searchHits(ctx.a.headers, pageId);
    assert.notEqual(hitsA.length, 0);
    assert.match(hitsA[0]!.citeAs, /^Page inbox-a \(v1, updated \d{4}-\d{2}-\d{2}\)$/);
    assert.notEqual((await searchHits(ctx.admin.headers, pageId)).length, 0);
    assert.notEqual((await searchHits(ctx.ownerHeaders, pageId)).length, 0);
    assert.equal((await searchHits(ctx.b.headers, pageId)).length, 0);
    assert.equal(await askCites(ctx.b.headers, pageId), false);
  });

  test('chunks of a normal-space page have no inbox owner', async () => {
    const pageId = await indexedPage(ctx.a.headers, ctx.open.id, 'open-a');
    const owners = await inboxOwners(pageId);
    assert.ok(owners.length > 0);
    assert.ok(owners.every((o) => o === null));
    assert.notEqual((await searchHits(ctx.b.headers, pageId)).length, 0);
  });

  test('moving the page out of the Inbox clears inbox_owner and B (with a grant) finds it', async () => {
    const pageId = await indexedPage(ctx.a.headers, ctx.inboxSpace.id, 'leave-inbox');
    assert.equal((await searchHits(ctx.b.headers, pageId)).length, 0);

    const res = await move(ctx.a.headers, pageId, ctx.open.id);
    assert.equal(res.statusCode, 200, res.body);

    const spaces = await chunkSpaces(pageId);
    assert.ok(spaces.length > 0);
    assert.ok(spaces.every((s) => s === ctx.open.id));
    const owners = await inboxOwners(pageId);
    assert.ok(owners.every((o) => o === null));
    assert.notEqual((await searchHits(ctx.b.headers, pageId)).length, 0);
    assert.notEqual((await searchHits(ctx.a.headers, pageId)).length, 0);
  });

  test('moving a page into the Inbox sets inbox_owner to its creator: only the creator and admins find it', async () => {
    const pageId = await indexedPage(ctx.a.headers, ctx.open.id, 'enter-inbox');
    assert.notEqual((await searchHits(ctx.b.headers, pageId)).length, 0);

    // A tenant admin moves A's page: the owner recorded is the creator, not the mover.
    const res = await move(ctx.admin.headers, pageId, ctx.inboxSpace.id);
    assert.equal(res.statusCode, 200, res.body);

    const owners = await inboxOwners(pageId);
    assert.ok(owners.length > 0);
    assert.deepEqual(new Set(owners), new Set([`user:${ctx.a.userId}`]));
    assert.notEqual((await searchHits(ctx.a.headers, pageId)).length, 0);
    assert.notEqual((await searchHits(ctx.admin.headers, pageId)).length, 0);
    assert.notEqual((await searchHits(ctx.ownerHeaders, pageId)).length, 0);
    assert.equal((await searchHits(ctx.b.headers, pageId)).length, 0);
  });
});
