import { describe, test, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import { and, eq } from 'drizzle-orm';
import { withTenantTx, versions, pages, chunks } from '@living-wiki/db';
import { AppError } from '@living-wiki/contracts';
import { takePageSnapshot, type Actor } from '@living-wiki/core';
import { runPendingJobsForTenant } from '../../worker/src/runner.js';
import {
  approveVersion,
  rejectVersion,
  withdrawPage,
  encodePageYDoc,
} from '../src/routes/pages.js';
import { buildTestApp, bootstrapTenant, signUpMember, useTestDb } from './support/testkit.js';

type Headers = Record<string, string>;

/**
 * Approve, reject and snapshot write version state under the document lock
 * (document row first, then version rows) and only move a version that is
 * still `pending_review`, so a withdraw that commits in between wins.
 */
describe('version writers take the document lock', () => {
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
    const { tenant, headers: ownerHeaders } = await bootstrapTenant(app, {
      name: 'Locks Co',
      slug: 'locks-co',
    });
    const open = await createSpace(ownerHeaders, 'open', false);
    const review = await createSpace(ownerHeaders, 'review', true);
    const editor = await signUpMember(app, tenant.id, 'member');
    const reviewer = await signUpMember(app, tenant.id, 'member');
    for (const s of [open, review]) await grant(ownerHeaders, s.id, editor.userId, 'editor');
    await grant(ownerHeaders, review.id, reviewer.userId, 'reviewer');
    const reviewerActor: Actor = {
      tenantId: tenant.id,
      principalType: 'user',
      principalId: reviewer.userId,
      tenantRole: 'member',
    };
    return { tenant, open, review, editor, reviewer, reviewerActor };
  }

  beforeEach(async () => {
    ctx = await setup();
  });

  async function createPage(headers: Headers, spaceId: string, slug: string, markdown: string) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/pages',
      headers,
      payload: { space_id: spaceId, title: `Page ${slug}`, slug, markdown },
    });
    assert.equal(res.statusCode, 201, res.body);
    return res.json().id as string;
  }

  async function snapshot(headers: Headers, pageId: string) {
    const res = await app.inject({ method: 'POST', url: `/api/v1/pages/${pageId}/snapshot`, headers });
    assert.equal(res.statusCode, 201, res.body);
    return res.json() as { id: string; status: string; number: number };
  }

  async function editLive(pageId: string, markdown: string) {
    const state = await encodePageYDoc('Locked page', markdown);
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

  async function chunkCount(pageId: string): Promise<number> {
    const rows = await withTenantTx(ctx.tenant.id, (tx) =>
      tx
        .select({ id: chunks.id })
        .from(chunks)
        .where(and(eq(chunks.tenantId, ctx.tenant.id), eq(chunks.documentId, pageId)))
    );
    return rows.length;
  }

  async function errorOf(p: Promise<unknown>): Promise<AppError> {
    const err = await p.then(
      () => assert.fail('expected the call to fail'),
      (e: unknown) => e
    );
    assert.ok(err instanceof AppError, `expected an AppError, got ${String(err)}`);
    return err;
  }

  test('a withdraw that commits before approve takes the lock wins: withdrawn, no chunks, 409', async () => {
    const pageId = await createPage(ctx.editor.headers, ctx.review.id, 'race', 'Quokkas on Fridays.');
    const v1 = await snapshot(ctx.editor.headers, pageId);
    assert.equal(v1.status, 'pending_review');
    let hookRan = false;

    const err = await errorOf(
      approveVersion(ctx.reviewerActor, v1.id, {}, {
        beforeLock: async () => {
          hookRan = true;
          await withdrawPage(ctx.reviewerActor, pageId);
        },
      })
    );

    assert.equal(hookRan, true, 'withdraw ran between the version read and the lock');
    assert.equal(err.code, 'version_not_pending');
    assert.equal(await versionStatus(v1.id), 'withdrawn');
    await runPendingJobsForTenant(ctx.tenant.id);
    assert.equal(await versionStatus(v1.id), 'withdrawn');
    assert.equal(await chunkCount(pageId), 0);
  });

  test('a withdraw that commits before reject takes the lock wins: withdrawn, 409', async () => {
    const pageId = await createPage(ctx.editor.headers, ctx.review.id, 'race-reject', 'Quokkas on Fridays.');
    const v1 = await snapshot(ctx.editor.headers, pageId);
    let hookRan = false;

    const err = await errorOf(
      rejectVersion(ctx.reviewerActor, v1.id, { review_note: 'no' }, {
        beforeLock: async () => {
          hookRan = true;
          await withdrawPage(ctx.reviewerActor, pageId);
        },
      })
    );

    assert.equal(hookRan, true);
    assert.equal(err.code, 'version_not_pending');
    assert.equal(await versionStatus(v1.id), 'withdrawn');
  });

  test('approve still answers 409 over HTTP for a version that is no longer pending', async () => {
    const pageId = await createPage(ctx.editor.headers, ctx.review.id, 'http', 'Quokkas on Fridays.');
    const v1 = await snapshot(ctx.editor.headers, pageId);
    await withdrawPage(ctx.reviewerActor, pageId);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/versions/${v1.id}/approve`,
      headers: ctx.reviewer.headers,
      payload: {},
    });
    assert.equal(res.statusCode, 409, res.body);
    assert.equal(res.json().error, 'version_not_pending');
  });

  test('a snapshot after an editor moved the page into a review space starts pending_review', async () => {
    const pageId = await createPage(ctx.editor.headers, ctx.open.id, 'mover', 'Quokkas on Fridays.');
    const v1 = await snapshot(ctx.editor.headers, pageId);
    assert.equal(v1.status, 'indexing');
    await runPendingJobsForTenant(ctx.tenant.id);
    assert.equal(await versionStatus(v1.id), 'indexed');

    await editLive(pageId, 'Quokkas on Fridays and Mondays.');
    const moved = await app.inject({
      method: 'POST',
      url: `/api/v1/pages/${pageId}/move`,
      headers: ctx.editor.headers,
      payload: { target_space_id: ctx.review.id },
    });
    assert.equal(moved.statusCode, 200, moved.body);

    const v2 = await snapshot(ctx.editor.headers, pageId);
    assert.equal(v2.number, 2);
    assert.equal(v2.status, 'pending_review');
    await runPendingJobsForTenant(ctx.tenant.id);
    assert.equal(await versionStatus(v2.id), 'pending_review');
    assert.equal(await chunkCount(pageId), 0);
  });

  test('a snapshot superseding the previous pending version leaves a withdrawn version withdrawn', async () => {
    const pageId = await createPage(ctx.editor.headers, ctx.review.id, 'supersede', 'Quokkas on Fridays.');
    const v1 = await snapshot(ctx.editor.headers, pageId);
    assert.equal(v1.status, 'pending_review');
    await editLive(pageId, 'Quokkas on Fridays and Mondays.');
    let hookRan = false;

    const v2 = await takePageSnapshot(
      {
        tenantId: ctx.tenant.id,
        pageId,
        reason: 'submit',
        actorType: 'user',
        actorId: ctx.editor.userId,
        manual: true,
      },
      {
        // The previous version is withdrawn after the snapshot decided to
        // supersede it: the supersede must not overwrite `withdrawn`.
        afterRead: async (tx) => {
          hookRan = true;
          await tx
            .update(versions)
            .set({ status: 'withdrawn' })
            .where(and(eq(versions.tenantId, ctx.tenant.id), eq(versions.id, v1.id)));
        },
      }
    );

    assert.equal(hookRan, true);
    assert.equal(v2!.number, 2);
    assert.equal(v2!.status, 'pending_review');
    assert.equal(await versionStatus(v1.id), 'withdrawn');
  });

  test('a superseded pending version still becomes superseded without a concurrent withdraw', async () => {
    const pageId = await createPage(ctx.editor.headers, ctx.review.id, 'supersede-ok', 'Quokkas on Fridays.');
    const v1 = await snapshot(ctx.editor.headers, pageId);
    await editLive(pageId, 'Quokkas on Fridays and Mondays.');

    const v2 = await snapshot(ctx.editor.headers, pageId);

    assert.equal(v2.status, 'pending_review');
    assert.equal(await versionStatus(v1.id), 'superseded');
  });
});
