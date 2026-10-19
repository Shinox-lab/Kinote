import { describe, test, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import { withTenantTx, versions, documents, pages, chunks, auditEvents } from '@living-wiki/db';
import { takePageSnapshot } from '@living-wiki/core';
import { runPendingJobsForTenant } from '../../worker/src/runner.js';
import { encodePageYDoc } from '../src/routes/pages.js';
import {
  buildTestApp,
  bootstrapTenant,
  signUpMember,
  useTestDb,
} from './support/testkit.js';

type Headers = Record<string, string>;

/**
 * Withdraw, archive and move as the spec has them: removing is fast and leaves
 * the index in the same transaction, moving across spaces moves the chunks,
 * moving into a review space sends the content back to review, cycles refused.
 */
describe('page lifecycle: withdraw, archive, move', () => {
  const app = buildTestApp();
  useTestDb();

  let ctx: Awaited<ReturnType<typeof setup>>;

  async function createSpace(headers: Headers, slug: string, reviewRequired: boolean) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/spaces',
      headers,
      payload: { name: slug, slug, review_required: reviewRequired },
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
    const { tenant, owner, headers: ownerHeaders } = await bootstrapTenant(app, {
      name: 'Lifecycle Co',
      slug: 'lifecycle-co',
    });
    const open = await createSpace(ownerHeaders, 'open', false);
    const review = await createSpace(ownerHeaders, 'review', true);
    const review2 = await createSpace(ownerHeaders, 'review-two', true);

    // editor: editor everywhere. reviewer: reviewer of both review spaces.
    // mover: editor of open, reviewer of review (a target-space reviewer).
    // openReader / reviewReader: viewers of exactly one space.
    const editor = await signUpMember(app, tenant.id, 'member');
    const reviewer = await signUpMember(app, tenant.id, 'member');
    const mover = await signUpMember(app, tenant.id, 'member');
    const openReader = await signUpMember(app, tenant.id, 'member');
    const reviewReader = await signUpMember(app, tenant.id, 'member');
    for (const s of [open, review, review2]) await grant(ownerHeaders, s.id, editor.userId, 'editor');
    await grant(ownerHeaders, review.id, reviewer.userId, 'reviewer');
    await grant(ownerHeaders, review2.id, reviewer.userId, 'reviewer');
    await grant(ownerHeaders, open.id, reviewer.userId, 'reviewer');
    await grant(ownerHeaders, open.id, mover.userId, 'editor');
    await grant(ownerHeaders, review.id, mover.userId, 'reviewer');
    await grant(ownerHeaders, open.id, openReader.userId, 'viewer');
    await grant(ownerHeaders, review.id, reviewReader.userId, 'viewer');

    return {
      tenant,
      owner,
      ownerHeaders,
      open,
      review,
      review2,
      editor,
      reviewer,
      mover,
      openReader,
      reviewReader,
    };
  }

  beforeEach(async () => {
    ctx = await setup();
  });

  const BODY_V1 = 'Quokkas are allowed in the office on Fridays.';
  const BODY_V2 = 'Quokkas are allowed in the office on Fridays and Mondays.';

  async function createPage(
    headers: Headers,
    spaceId: string,
    slug: string,
    markdown = BODY_V1,
    parentId: string | null = null
  ): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/pages',
      headers,
      payload: { space_id: spaceId, title: `Page ${slug}`, slug, markdown, parent_id: parentId },
    });
    assert.equal(res.statusCode, 201, res.body);
    return res.json().id;
  }

  async function snapshot(headers: Headers, pageId: string) {
    const res = await app.inject({ method: 'POST', url: `/api/v1/pages/${pageId}/snapshot`, headers });
    assert.equal(res.statusCode, 201, res.body);
    return res.json() as { id: string; status: string; number: number };
  }

  async function approve(headers: Headers, versionId: string) {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/versions/${versionId}/approve`,
      headers,
      payload: {},
    });
    assert.equal(res.statusCode, 200, res.body);
  }

  /** Replaces the page's live content (what an editing session would do). */
  async function editLive(pageId: string, title: string, markdown: string) {
    const state = await encodePageYDoc(title, markdown);
    await withTenantTx(ctx.tenant.id, (tx) =>
      tx
        .update(pages)
        .set({ ydocState: state, liveChangedSinceSnapshot: true })
        .where(and(eq(pages.tenantId, ctx.tenant.id), eq(pages.documentId, pageId)))
    );
  }

  async function versionStatus(versionId: string): Promise<string> {
    const [row] = await withTenantTx(ctx.tenant.id, (tx) =>
      tx
        .select({ status: versions.status })
        .from(versions)
        .where(and(eq(versions.tenantId, ctx.tenant.id), eq(versions.id, versionId)))
    );
    return row!.status;
  }

  async function documentRow(pageId: string) {
    const [row] = await withTenantTx(ctx.tenant.id, (tx) =>
      tx
        .select()
        .from(documents)
        .where(and(eq(documents.tenantId, ctx.tenant.id), eq(documents.id, pageId)))
    );
    return row!;
  }

  async function chunkRows(pageId: string) {
    return withTenantTx(ctx.tenant.id, (tx) =>
      tx
        .select()
        .from(chunks)
        .where(and(eq(chunks.tenantId, ctx.tenant.id), eq(chunks.documentId, pageId)))
        .orderBy(asc(chunks.ordinal))
    );
  }

  async function searchHits(headers: Headers, pageId: string, query = 'quokkas office') {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/search',
      headers,
      payload: { query },
    });
    assert.equal(res.statusCode, 200, res.body);
    return (res.json().passages as Array<{ documentId: string }>).filter((p) => p.documentId === pageId);
  }

  async function badge(headers: Headers, pageId: string): Promise<string> {
    const res = await app.inject({ method: 'GET', url: `/api/v1/pages/${pageId}`, headers });
    assert.equal(res.statusCode, 200, res.body);
    return res.json().badge;
  }

  function move(headers: Headers, pageId: string, payload: Record<string, unknown>) {
    return app.inject({ method: 'POST', url: `/api/v1/pages/${pageId}/move`, headers, payload });
  }

  /** A page in the review space with v1 indexed and v2 waiting for review. */
  async function indexedV1PendingV2(spaceId: string, slug: string) {
    const pageId = await createPage(ctx.editor.headers, spaceId, slug);
    const v1 = await snapshot(ctx.editor.headers, pageId);
    assert.equal(v1.status, 'pending_review');
    await approve(ctx.reviewer.headers, v1.id);
    await runPendingJobsForTenant(ctx.tenant.id);
    assert.equal(await versionStatus(v1.id), 'indexed');
    await editLive(pageId, `Page ${slug}`, BODY_V2);
    const v2 = await snapshot(ctx.editor.headers, pageId);
    assert.equal(v2.status, 'pending_review');
    assert.equal(v2.number, 2);
    return { pageId, v1, v2 };
  }

  /** A page in the open space with v1 indexed. */
  async function indexedV1InOpenSpace(slug: string) {
    const pageId = await createPage(ctx.editor.headers, ctx.open.id, slug);
    const v1 = await snapshot(ctx.editor.headers, pageId);
    assert.equal(v1.status, 'indexing');
    await runPendingJobsForTenant(ctx.tenant.id);
    assert.equal(await versionStatus(v1.id), 'indexed');
    assert.ok((await chunkRows(pageId)).length > 0);
    return { pageId, v1 };
  }

  test('withdraw with v1 indexed and v2 pending withdraws both, empties the index and badges Withdrawn', async () => {
    const { pageId, v1, v2 } = await indexedV1PendingV2(ctx.review.id, 'withdraw-me');
    assert.ok((await chunkRows(pageId)).length > 0);
    assert.notEqual((await searchHits(ctx.ownerHeaders, pageId)).length, 0);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/pages/${pageId}/withdraw`,
      headers: ctx.reviewer.headers,
    });
    assert.equal(res.statusCode, 200, res.body);

    assert.equal(await versionStatus(v1.id), 'withdrawn');
    assert.equal(await versionStatus(v2.id), 'withdrawn');
    assert.equal((await chunkRows(pageId)).length, 0);
    assert.equal((await documentRow(pageId)).indexedVersionId, null);
    assert.equal(await badge(ctx.reviewer.headers, pageId), 'Withdrawn');
    assert.equal((await searchHits(ctx.ownerHeaders, pageId)).length, 0);
    assert.equal((await searchHits(ctx.reviewReader.headers, pageId)).length, 0);

    const audit = await withTenantTx(ctx.tenant.id, (tx) =>
      tx
        .select()
        .from(auditEvents)
        .where(and(eq(auditEvents.tenantId, ctx.tenant.id), eq(auditEvents.type, 'page.withdrawn')))
    );
    assert.equal(audit.length, 1);
    assert.equal(audit[0]!.subjectId, pageId);
  });

  test('withdraw also withdraws a version that is still indexing, and its job never indexes it', async () => {
    const { pageId, v1 } = await indexedV1InOpenSpace('withdraw-indexing');
    await editLive(pageId, 'Page withdraw-indexing', BODY_V2);
    const v2 = await snapshot(ctx.editor.headers, pageId);
    assert.equal(v2.status, 'indexing');

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/pages/${pageId}/withdraw`,
      headers: ctx.reviewer.headers,
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(await versionStatus(v1.id), 'withdrawn');
    assert.equal(await versionStatus(v2.id), 'withdrawn');

    await runPendingJobsForTenant(ctx.tenant.id);
    assert.equal(await versionStatus(v2.id), 'withdrawn');
    assert.equal((await chunkRows(pageId)).length, 0);
    assert.equal((await documentRow(pageId)).indexedVersionId, null);
  });

  test('withdraw needs a reviewer; an editor is refused and nothing changes', async () => {
    const { pageId, v1 } = await indexedV1InOpenSpace('editor-cannot-withdraw');
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/pages/${pageId}/withdraw`,
      headers: ctx.mover.headers,
    });
    assert.equal(res.statusCode, 403, res.body);
    assert.equal(await versionStatus(v1.id), 'indexed');
    assert.ok((await chunkRows(pageId)).length > 0);
  });

  test('withdraw of an unknown page answers 404 page_not_found', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/pages/${randomUUID()}/withdraw`,
      headers: ctx.ownerHeaders,
    });
    assert.equal(res.statusCode, 404, res.body);
    assert.equal(res.json().error, 'page_not_found');
  });

  describe('submitting a withdrawn page again', () => {
    function withdraw(pageId: string) {
      return app.inject({
        method: 'POST',
        url: `/api/v1/pages/${pageId}/withdraw`,
        headers: ctx.reviewer.headers,
      });
    }

    test('unchanged content after a withdraw makes a new version, indexed again', async () => {
      const { pageId, v1 } = await indexedV1InOpenSpace('withdraw-resubmit');
      assert.equal((await withdraw(pageId)).statusCode, 200);
      assert.equal(await versionStatus(v1.id), 'withdrawn');

      const v2 = await snapshot(ctx.editor.headers, pageId);
      assert.equal(v2.number, 2);
      assert.equal(v2.status, 'indexing');
      await runPendingJobsForTenant(ctx.tenant.id);

      assert.equal(await versionStatus(v2.id), 'indexed');
      assert.equal(await versionStatus(v1.id), 'withdrawn');
      assert.equal((await documentRow(pageId)).indexedVersionId, v2.id);
      assert.ok((await chunkRows(pageId)).length > 0);
      assert.notEqual((await searchHits(ctx.ownerHeaders, pageId)).length, 0);
      assert.equal(await badge(ctx.editor.headers, pageId), 'Indexed · v2');

      // Submitting the same content again is no_changes once more.
      const again = await app.inject({
        method: 'POST',
        url: `/api/v1/pages/${pageId}/snapshot`,
        headers: ctx.editor.headers,
      });
      assert.equal(again.statusCode, 409, again.body);
      assert.equal(again.json().error, 'no_changes');
    });

    test('in a review space it waits for review and is indexed after approval', async () => {
      const { pageId, v1, v2 } = await indexedV1PendingV2(ctx.review.id, 'withdraw-resubmit-review');
      assert.equal((await withdraw(pageId)).statusCode, 200);

      const v3 = await snapshot(ctx.editor.headers, pageId);
      assert.equal(v3.number, 3);
      assert.equal(v3.status, 'pending_review');
      assert.equal(await versionStatus(v2.id), 'withdrawn');
      assert.equal((await chunkRows(pageId)).length, 0);

      await approve(ctx.reviewer.headers, v3.id);
      await runPendingJobsForTenant(ctx.tenant.id);
      assert.equal(await versionStatus(v3.id), 'indexed');
      assert.equal(await versionStatus(v1.id), 'withdrawn');
      assert.equal((await documentRow(pageId)).indexedVersionId, v3.id);
      assert.notEqual((await searchHits(ctx.ownerHeaders, pageId)).length, 0);
    });

    test('an archived page restored and submitted unchanged is indexed again', async () => {
      const { pageId, v1 } = await indexedV1InOpenSpace('archive-restore-resubmit');
      for (const action of ['archive', 'restore']) {
        const res = await app.inject({
          method: 'POST',
          url: `/api/v1/pages/${pageId}/${action}`,
          headers: ctx.ownerHeaders,
        });
        assert.equal(res.statusCode, 200, res.body);
      }
      assert.equal(await badge(ctx.editor.headers, pageId), 'Withdrawn');

      const v2 = await snapshot(ctx.editor.headers, pageId);
      assert.equal(v2.status, 'indexing');
      await runPendingJobsForTenant(ctx.tenant.id);
      assert.equal(await versionStatus(v2.id), 'indexed');
      assert.equal(await versionStatus(v1.id), 'withdrawn');
      assert.notEqual((await searchHits(ctx.ownerHeaders, pageId)).length, 0);
    });

    test('a quiet snapshot of a withdrawn page with unchanged content adds no version', async () => {
      // Only an explicit submit puts a withdrawn page back: the quiet timer
      // never undoes a withdraw on its own.
      const { pageId, v1 } = await indexedV1InOpenSpace('withdraw-quiet');
      assert.equal((await withdraw(pageId)).statusCode, 200);

      const result = await takePageSnapshot({
        tenantId: ctx.tenant.id,
        pageId,
        reason: 'quiet',
        actorType: 'user',
        actorId: ctx.editor.userId,
        manual: false,
      });
      assert.equal(result?.id, v1.id);
      const rows = await withTenantTx(ctx.tenant.id, (tx) =>
        tx
          .select({ status: versions.status })
          .from(versions)
          .where(and(eq(versions.tenantId, ctx.tenant.id), eq(versions.documentId, pageId)))
      );
      assert.deepEqual(rows, [{ status: 'withdrawn' }]);
      assert.equal((await chunkRows(pageId)).length, 0);
    });
  });

  test('archive with a version in indexing withdraws it and removes the chunks', async () => {
    const { pageId, v1 } = await indexedV1InOpenSpace('archive-me');
    await editLive(pageId, 'Page archive-me', BODY_V2);
    const v2 = await snapshot(ctx.editor.headers, pageId);
    assert.equal(v2.status, 'indexing');

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/pages/${pageId}/archive`,
      headers: ctx.ownerHeaders,
    });
    assert.equal(res.statusCode, 200, res.body);

    assert.equal(await versionStatus(v1.id), 'withdrawn');
    assert.equal(await versionStatus(v2.id), 'withdrawn');
    assert.equal((await chunkRows(pageId)).length, 0);
    const doc = await documentRow(pageId);
    assert.equal(doc.indexedVersionId, null);
    assert.ok(doc.archivedAt);
    assert.equal((await searchHits(ctx.ownerHeaders, pageId)).length, 0);

    // The queued job for v2 finds it withdrawn and leaves the index empty.
    await runPendingJobsForTenant(ctx.tenant.id);
    assert.equal(await versionStatus(v2.id), 'withdrawn');
    assert.equal((await chunkRows(pageId)).length, 0);
  });

  test('archive is refused while a live child exists', async () => {
    const parent = await createPage(ctx.editor.headers, ctx.open.id, 'parent');
    await createPage(ctx.editor.headers, ctx.open.id, 'child', BODY_V1, parent);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/pages/${parent}/archive`,
      headers: ctx.ownerHeaders,
    });
    assert.equal(res.statusCode, 409, res.body);
    assert.equal(res.json().error, 'has_children');
    assert.equal((await documentRow(parent)).archivedAt, null);
  });

  test('move into a review space by an editor with only v1 indexed returns v1 to pending_review', async () => {
    const { pageId, v1 } = await indexedV1InOpenSpace('move-to-review');

    const res = await move(ctx.editor.headers, pageId, { target_space_id: ctx.review.id });
    assert.equal(res.statusCode, 200, res.body);

    assert.equal(await versionStatus(v1.id), 'pending_review');
    assert.equal((await chunkRows(pageId)).length, 0);
    const doc = await documentRow(pageId);
    assert.equal(doc.indexedVersionId, null);
    assert.equal(doc.spaceId, ctx.review.id);
    assert.equal((await searchHits(ctx.ownerHeaders, pageId)).length, 0);
  });

  test('move into a review space with a pending v2 supersedes v1 and keeps v2 pending', async () => {
    const { pageId, v1, v2 } = await indexedV1PendingV2(ctx.review.id, 'move-pending');

    const res = await move(ctx.editor.headers, pageId, { target_space_id: ctx.review2.id });
    assert.equal(res.statusCode, 200, res.body);

    assert.equal(await versionStatus(v1.id), 'superseded');
    assert.equal(await versionStatus(v2.id), 'pending_review');
    assert.equal((await chunkRows(pageId)).length, 0);
    assert.equal((await documentRow(pageId)).indexedVersionId, null);
  });

  test('move into a review space returns a version in indexing to pending_review', async () => {
    const pageId = await createPage(ctx.editor.headers, ctx.open.id, 'move-indexing');
    const v1 = await snapshot(ctx.editor.headers, pageId);
    assert.equal(v1.status, 'indexing');

    const res = await move(ctx.editor.headers, pageId, { target_space_id: ctx.review.id });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(await versionStatus(v1.id), 'pending_review');

    // Its queued job no longer indexes it.
    await runPendingJobsForTenant(ctx.tenant.id);
    assert.equal(await versionStatus(v1.id), 'pending_review');
    assert.equal((await chunkRows(pageId)).length, 0);
    assert.equal((await documentRow(pageId)).indexedVersionId, null);
  });

  test('move into a review space with v1 indexed and v2 indexing leaves only v2 pending', async () => {
    const { pageId, v1 } = await indexedV1InOpenSpace('move-indexed-and-indexing');
    await editLive(pageId, 'Page move-indexed-and-indexing', BODY_V2);
    const v2 = await snapshot(ctx.editor.headers, pageId);
    assert.equal(v2.status, 'indexing');

    const res = await move(ctx.editor.headers, pageId, { target_space_id: ctx.review.id });
    assert.equal(res.statusCode, 200, res.body);

    assert.equal(await versionStatus(v2.id), 'pending_review');
    assert.equal(await versionStatus(v1.id), 'superseded');
    assert.equal((await chunkRows(pageId)).length, 0);
    assert.equal((await documentRow(pageId)).indexedVersionId, null);
  });

  test('move by a target-space reviewer moves the chunks and keeps v1 indexed', async () => {
    const { pageId, v1 } = await indexedV1InOpenSpace('reviewer-moves');
    const before = await chunkRows(pageId);
    assert.notEqual((await searchHits(ctx.openReader.headers, pageId)).length, 0);
    assert.equal((await searchHits(ctx.reviewReader.headers, pageId)).length, 0);

    const res = await move(ctx.mover.headers, pageId, { target_space_id: ctx.review.id });
    assert.equal(res.statusCode, 200, res.body);

    assert.equal(await versionStatus(v1.id), 'indexed');
    const after = await chunkRows(pageId);
    assert.deepEqual(
      after.map((c) => c.id),
      before.map((c) => c.id)
    );
    assert.ok(after.every((c) => c.spaceId === ctx.review.id));
    assert.equal((await documentRow(pageId)).indexedVersionId, v1.id);
    assert.notEqual((await searchHits(ctx.reviewReader.headers, pageId)).length, 0);
    assert.equal((await searchHits(ctx.openReader.headers, pageId)).length, 0);
  });

  test('a same-space move changes only parent and position', async () => {
    const { pageId, v1 } = await indexedV1InOpenSpace('same-space');
    const newParent = await createPage(ctx.editor.headers, ctx.open.id, 'new-parent');
    const before = await chunkRows(pageId);

    const res = await move(ctx.editor.headers, pageId, {
      target_space_id: ctx.open.id,
      target_parent_id: newParent,
      position: 'b1',
    });
    assert.equal(res.statusCode, 200, res.body);
    const doc = await documentRow(pageId);
    assert.equal(doc.parentId, newParent);
    assert.equal(doc.position, 'b1');
    assert.equal(doc.indexedVersionId, v1.id);
    assert.equal(await versionStatus(v1.id), 'indexed');
    assert.deepEqual(
      (await chunkRows(pageId)).map((c) => [c.id, c.spaceId]),
      before.map((c) => [c.id, c.spaceId])
    );
  });

  test('moving A under its grandchild, or under itself, is 409 parent_cycle', async () => {
    const a = await createPage(ctx.editor.headers, ctx.open.id, 'a');
    const b = await createPage(ctx.editor.headers, ctx.open.id, 'b', BODY_V1, a);
    const c = await createPage(ctx.editor.headers, ctx.open.id, 'c', BODY_V1, b);

    const underGrandchild = await move(ctx.editor.headers, a, {
      target_space_id: ctx.open.id,
      target_parent_id: c,
    });
    assert.equal(underGrandchild.statusCode, 409, underGrandchild.body);
    assert.equal(underGrandchild.json().error, 'parent_cycle');

    const underItself = await move(ctx.editor.headers, a, {
      target_space_id: ctx.open.id,
      target_parent_id: a,
    });
    assert.equal(underItself.statusCode, 409, underItself.body);
    assert.equal(underItself.json().error, 'parent_cycle');

    assert.equal((await documentRow(a)).parentId, null);

    // Moving the grandchild under A (not a cycle) is fine.
    const ok = await move(ctx.editor.headers, c, { target_space_id: ctx.open.id, target_parent_id: a });
    assert.equal(ok.statusCode, 200, ok.body);
    assert.equal((await documentRow(c)).parentId, a);
  });

  test('the target parent must be a live page in the target space (404 parent_not_found)', async () => {
    const a = await createPage(ctx.editor.headers, ctx.open.id, 'pa');
    const elsewhere = await createPage(ctx.editor.headers, ctx.review.id, 'pb');

    const wrongSpace = await move(ctx.editor.headers, a, {
      target_space_id: ctx.open.id,
      target_parent_id: elsewhere,
    });
    assert.equal(wrongSpace.statusCode, 404, wrongSpace.body);
    assert.equal(wrongSpace.json().error, 'parent_not_found');

    const unknown = await move(ctx.editor.headers, a, {
      target_space_id: ctx.open.id,
      target_parent_id: randomUUID(),
    });
    assert.equal(unknown.statusCode, 404, unknown.body);
    assert.equal(unknown.json().error, 'parent_not_found');
  });

  test('the cycle check walks a deep tree (60 levels)', async () => {
    const root = await createPage(ctx.editor.headers, ctx.open.id, 'deep-root');
    const ids: string[] = [];
    await withTenantTx(ctx.tenant.id, async (tx) => {
      let parent = root;
      for (let i = 0; i < 60; i++) {
        const id = randomUUID();
        await tx.insert(documents).values({
          id,
          tenantId: ctx.tenant.id,
          spaceId: ctx.open.id,
          parentId: parent,
          kind: 'page',
          title: `Level ${i + 1}`,
          createdByType: 'user',
          createdBy: ctx.editor.userId,
        });
        ids.push(id);
        parent = id;
      }
    });
    const deepest = ids[ids.length - 1]!;

    const cycle = await move(ctx.editor.headers, root, {
      target_space_id: ctx.open.id,
      target_parent_id: deepest,
    });
    assert.equal(cycle.statusCode, 409, cycle.body);
    assert.equal(cycle.json().error, 'parent_cycle');

    // A mid-tree node under the deepest node is also a cycle.
    const midCycle = await move(ctx.editor.headers, ids[10]!, {
      target_space_id: ctx.open.id,
      target_parent_id: deepest,
    });
    assert.equal(midCycle.statusCode, 409, midCycle.body);
    assert.equal(midCycle.json().error, 'parent_cycle');

    // An unrelated page may move under the deepest node.
    const other = await createPage(ctx.editor.headers, ctx.open.id, 'unrelated');
    const ok = await move(ctx.editor.headers, other, {
      target_space_id: ctx.open.id,
      target_parent_id: deepest,
    });
    assert.equal(ok.statusCode, 200, ok.body);
  });

  /** Marks a version `failed` the way the worker's dead-letter hook does. */
  async function markFailed(versionId: string) {
    await withTenantTx(ctx.tenant.id, (tx) =>
      tx
        .update(versions)
        .set({ status: 'failed', error: 'Indexing failed after 5 attempts: embedding service down' })
        .where(and(eq(versions.tenantId, ctx.tenant.id), eq(versions.id, versionId)))
    );
  }

  function retry(headers: Headers, versionId: string) {
    return app.inject({ method: 'POST', url: `/api/v1/versions/${versionId}/retry`, headers });
  }

  test('withdraw also withdraws a failed version, so Retry cannot bring the content back', async () => {
    const { pageId, v1, v2 } = await indexedV1PendingV2(ctx.review.id, 'withdraw-failed');
    await approve(ctx.reviewer.headers, v2.id);
    await markFailed(v2.id);
    assert.equal(await badge(ctx.editor.headers, pageId), 'Index failed');

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/pages/${pageId}/withdraw`,
      headers: ctx.reviewer.headers,
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(await versionStatus(v1.id), 'withdrawn');
    assert.equal(await versionStatus(v2.id), 'withdrawn');

    const retried = await retry(ctx.editor.headers, v2.id);
    assert.equal(retried.statusCode, 409, retried.body);
    assert.equal(retried.json().error, 'version_not_failed');

    await runPendingJobsForTenant(ctx.tenant.id);
    assert.equal(await versionStatus(v2.id), 'withdrawn');
    assert.equal((await chunkRows(pageId)).length, 0);
    assert.equal((await documentRow(pageId)).indexedVersionId, null);
    assert.equal((await searchHits(ctx.ownerHeaders, pageId)).length, 0);
  });

  test('a failed version on a page moved into a review space by an editor goes back to review', async () => {
    const { pageId, v1 } = await indexedV1InOpenSpace('move-failed');
    await editLive(pageId, 'Page move-failed', BODY_V2);
    const v2 = await snapshot(ctx.editor.headers, pageId);
    assert.equal(v2.status, 'indexing');
    await markFailed(v2.id);

    const res = await move(ctx.editor.headers, pageId, { target_space_id: ctx.review.id });
    assert.equal(res.statusCode, 200, res.body);

    assert.equal(await versionStatus(v2.id), 'pending_review');
    assert.equal(await versionStatus(v1.id), 'superseded');
    const [v2Row] = await withTenantTx(ctx.tenant.id, (tx) =>
      tx
        .select({ error: versions.error })
        .from(versions)
        .where(and(eq(versions.tenantId, ctx.tenant.id), eq(versions.id, v2.id)))
    );
    assert.equal(v2Row!.error, null);

    const retried = await retry(ctx.editor.headers, v2.id);
    assert.equal(retried.statusCode, 409, retried.body);
    assert.equal(retried.json().error, 'version_not_failed');

    await runPendingJobsForTenant(ctx.tenant.id);
    assert.equal(await versionStatus(v2.id), 'pending_review');
    assert.equal((await chunkRows(pageId)).length, 0);
    assert.equal((await documentRow(pageId)).indexedVersionId, null);
  });

  test('a lone failed version on a page moved into a review space becomes pending_review', async () => {
    const pageId = await createPage(ctx.editor.headers, ctx.open.id, 'move-lone-failed');
    const v1 = await snapshot(ctx.editor.headers, pageId);
    await markFailed(v1.id);

    const res = await move(ctx.editor.headers, pageId, { target_space_id: ctx.review.id });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(await versionStatus(v1.id), 'pending_review');
    assert.equal((await retry(ctx.editor.headers, v1.id)).statusCode, 409);
  });

  test('Retry of a failed version on an archived page is 409 page_archived', async () => {
    const pageId = await createPage(ctx.editor.headers, ctx.open.id, 'retry-archived');
    const v1 = await snapshot(ctx.editor.headers, pageId);
    const archived = await app.inject({
      method: 'POST',
      url: `/api/v1/pages/${pageId}/archive`,
      headers: ctx.ownerHeaders,
    });
    assert.equal(archived.statusCode, 200, archived.body);
    assert.equal(await versionStatus(v1.id), 'withdrawn');
    await markFailed(v1.id);

    const retried = await retry(ctx.editor.headers, v1.id);
    assert.equal(retried.statusCode, 409, retried.body);
    assert.equal(retried.json().error, 'page_archived');
    assert.equal(await versionStatus(v1.id), 'failed');
    assert.equal((await chunkRows(pageId)).length, 0);
  });

  test('an archived page cannot be moved (409 page_archived)', async () => {
    const pageId = await createPage(ctx.editor.headers, ctx.open.id, 'gone');
    const archived = await app.inject({
      method: 'POST',
      url: `/api/v1/pages/${pageId}/archive`,
      headers: ctx.ownerHeaders,
    });
    assert.equal(archived.statusCode, 200, archived.body);
    const res = await move(ctx.editor.headers, pageId, { target_space_id: ctx.review.id });
    assert.equal(res.statusCode, 409, res.body);
    assert.equal(res.json().error, 'page_archived');
  });

  describe('moving into the Inbox (R27)', () => {
    async function inboxId(headers: Headers): Promise<string> {
      const res = await app.inject({ method: 'GET', url: '/api/v1/spaces', headers });
      assert.equal(res.statusCode, 200, res.body);
      return (res.json() as Array<{ id: string; kind: string }>).find((s) => s.kind === 'inbox')!.id;
    }

    test('only the creator or a tenant admin may move a page into the Inbox', async () => {
      const inbox = await inboxId(ctx.ownerHeaders);
      // `editor` creates the pages; `mover` is also an editor of the same space.
      const p1 = await createPage(ctx.editor.headers, ctx.open.id, 'into-inbox-1');
      const p2 = await createPage(ctx.editor.headers, ctx.open.id, 'into-inbox-2');
      const p3 = await createPage(ctx.editor.headers, ctx.open.id, 'into-inbox-3');

      const other = await move(ctx.mover.headers, p1, { target_space_id: inbox });
      assert.equal(other.statusCode, 403, other.body);
      assert.equal(other.json().error, 'forbidden');
      assert.equal((await documentRow(p1)).spaceId, ctx.open.id);

      const creator = await move(ctx.editor.headers, p2, { target_space_id: inbox });
      assert.equal(creator.statusCode, 200, creator.body);
      assert.equal((await documentRow(p2)).spaceId, inbox);

      const admin = await move(ctx.ownerHeaders, p3, { target_space_id: inbox });
      assert.equal(admin.statusCode, 200, admin.body);
      assert.equal((await documentRow(p3)).spaceId, inbox);
    });
  });
});
