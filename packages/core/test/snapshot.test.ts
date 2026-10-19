import { describe, test, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import * as Y from 'yjs';
import { ServerBlockNoteEditor } from '@blocknote/server-util';
import { and, eq } from 'drizzle-orm';
import { withTenantTx, pages, links, versions } from '@living-wiki/db';
import { flattenBlocks, type BlockLike } from '@living-wiki/shared';
import { takePageSnapshot } from '../src/index.js';
import { encodePageYDoc } from '../../../apps/api/src/routes/pages.js';
import {
  buildTestApp,
  bootstrapTenant,
  useTestDb,
} from '../../../apps/api/test/support/testkit.js';

type Headers = Record<string, string>;

const editor = ServerBlockNoteEditor.create();

/**
 * Snapshot hardening: a change that lands while a snapshot is taken stays
 * flagged as "changed since", and `[[document-id]]` links are read from real
 * BlockNote blocks (nested children included) and recorded only when they
 * point at a document of the same tenant.
 */
describe('takePageSnapshot', () => {
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

  async function createPage(headers: Headers, spaceId: string, slug: string, markdown: string) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/pages',
      headers,
      payload: { space_id: spaceId, title: `Page ${slug}`, slug, markdown },
    });
    assert.equal(res.statusCode, 201, res.body);
    return res.json().document.id as string;
  }

  async function setup() {
    const { tenant, owner, headers } = await bootstrapTenant(app, {
      name: 'Snapshot Co',
      slug: 'snapshot-co',
    });
    const open = await createSpace(headers, 'open', false);
    const review = await createSpace(headers, 'review', true);

    const other = await bootstrapTenant(app, { name: 'Other Co', slug: 'other-co' });
    const otherSpace = await createSpace(other.headers, 'other-open', false);
    const otherDocId = await createPage(other.headers, otherSpace.id, 'secret', 'Other tenant page.');

    return { tenant, owner, headers, open, review, otherDocId };
  }

  beforeEach(async () => {
    ctx = await setup();
  });

  function snap(pageId: string, hooks?: Parameters<typeof takePageSnapshot>[1]) {
    return takePageSnapshot(
      {
        tenantId: ctx.tenant.id,
        pageId,
        reason: 'submit',
        actorType: 'user',
        actorId: ctx.owner.userId,
        manual: true,
      },
      hooks
    );
  }

  async function pageRow(pageId: string) {
    const [row] = await withTenantTx(ctx.tenant.id, (tx) =>
      tx
        .select()
        .from(pages)
        .where(and(eq(pages.tenantId, ctx.tenant.id), eq(pages.documentId, pageId)))
    );
    return row!;
  }

  async function badge(pageId: string): Promise<string> {
    const res = await app.inject({ method: 'GET', url: `/api/v1/pages/${pageId}`, headers: ctx.headers });
    assert.equal(res.statusCode, 200, res.body);
    return res.json().badge;
  }

  /** Replaces the page's live content (what an editing session would do). */
  async function editLive(pageId: string, markdown: string) {
    const state = await encodePageYDoc('Linking page', markdown);
    await withTenantTx(ctx.tenant.id, (tx) =>
      tx
        .update(pages)
        .set({ ydocState: state, liveChangedSinceSnapshot: true })
        .where(and(eq(pages.tenantId, ctx.tenant.id), eq(pages.documentId, pageId)))
    );
  }

  /** The live blocks of a page, flattened (nested children included). */
  async function liveFlatBlocks(pageId: string) {
    const ydoc = new Y.Doc();
    Y.applyUpdate(ydoc, (await pageRow(pageId)).ydocState);
    return flattenBlocks(editor.yDocToBlocks(ydoc, 'document-store') as BlockLike[]);
  }

  async function blockIdContaining(pageId: string, text: string): Promise<string> {
    const found = (await liveFlatBlocks(pageId)).filter((b) => b.text.includes(text));
    assert.equal(found.length, 1, `exactly one block contains "${text}"`);
    return found[0]!.id;
  }

  async function linkRows(pageId: string) {
    const rows = await withTenantTx(ctx.tenant.id, (tx) =>
      tx
        .select({ fromBlockId: links.fromBlockId, toDocumentId: links.toDocumentId, kind: links.kind })
        .from(links)
        .where(and(eq(links.tenantId, ctx.tenant.id), eq(links.fromPageId, pageId)))
    );
    return rows.sort((a, b) =>
      `${a.fromBlockId}:${a.toDocumentId}`.localeCompare(`${b.fromBlockId}:${b.toDocumentId}`)
    );
  }

  describe('a change made while the snapshot runs', () => {
    test('without a concurrent change the snapshot clears the changed-since flag', async () => {
      const pageId = await createPage(ctx.headers, ctx.review.id, 'quiet', 'Quokkas are welcome.');
      assert.equal((await pageRow(pageId)).liveChangedSinceSnapshot, true);

      const v1 = await snap(pageId);

      assert.equal(v1!.status, 'pending_review');
      assert.equal((await pageRow(pageId)).liveChangedSinceSnapshot, false);
      assert.equal(await badge(pageId), 'Saved · not indexed (awaiting approval)');
    });

    test('typing that lands after the page row was read keeps the page flagged', async () => {
      const pageId = await createPage(ctx.headers, ctx.review.id, 'race', 'Quokkas are welcome.');
      const before = await pageRow(pageId);
      let hookRan = false;

      const v1 = await snap(pageId, {
        afterRead: async (tx) => {
          hookRan = true;
          await tx
            .update(pages)
            .set({
              liveUpdatedAt: new Date(before.liveUpdatedAt.getTime() + 1000),
              liveChangedSinceSnapshot: true,
            })
            .where(and(eq(pages.tenantId, ctx.tenant.id), eq(pages.documentId, pageId)));
        },
      });

      assert.equal(hookRan, true, 'afterRead ran inside the snapshot');
      assert.equal(v1!.number, 1);
      assert.equal(v1!.status, 'pending_review');
      assert.equal((await pageRow(pageId)).liveChangedSinceSnapshot, true);
      assert.equal(await badge(pageId), 'Saved · changed since v1, awaiting approval');
    });
  });

  describe('archived pages', () => {
    async function versionCount(pageId: string) {
      const rows = await withTenantTx(ctx.tenant.id, (tx) =>
        tx
          .select({ id: versions.id })
          .from(versions)
          .where(and(eq(versions.tenantId, ctx.tenant.id), eq(versions.documentId, pageId)))
      );
      return rows.length;
    }

    async function archive(pageId: string) {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/pages/${pageId}/archive`,
        headers: ctx.headers,
      });
      assert.equal(res.statusCode, 200, res.body);
    }

    test('a manual snapshot of an archived page is 409 page_archived and creates no version', async () => {
      const pageId = await createPage(ctx.headers, ctx.open.id, 'archived-manual', 'Quokkas are welcome.');
      await archive(pageId);
      await editLive(pageId, 'Typed after the archive.');

      await assert.rejects(snap(pageId), (err: any) => err.code === 'page_archived');
      assert.equal(await versionCount(pageId), 0);
    });

    test('a quiet (non-manual) snapshot of an archived page returns null and creates no version', async () => {
      const pageId = await createPage(ctx.headers, ctx.open.id, 'archived-quiet', 'Quokkas are welcome.');
      await archive(pageId);
      await editLive(pageId, 'Typed after the archive.');

      const result = await takePageSnapshot({
        tenantId: ctx.tenant.id,
        pageId,
        reason: 'quiet',
        actorType: 'user',
        actorId: ctx.owner.userId,
        manual: false,
      });
      assert.equal(result, null);
      assert.equal(await versionCount(pageId), 0);
    });
  });

  describe('[[links]]', () => {
    test('a link to an existing document of the same tenant is recorded with the real block id', async () => {
      const targetId = await createPage(ctx.headers, ctx.open.id, 'target', 'Target page.');
      const pageId = await createPage(ctx.headers, ctx.open.id, 'linking', 'Placeholder.');
      await editLive(pageId, `Intro paragraph.\n\nSee [[${targetId}]] for details.`);
      const blockId = await blockIdContaining(pageId, 'for details');

      await snap(pageId);

      assert.deepEqual(await linkRows(pageId), [
        { fromBlockId: blockId, toDocumentId: targetId, kind: 'link' },
      ]);
    });

    test('a random uuid, a malformed id and another tenant document are ignored and the snapshot still succeeds', async () => {
      const targetId = await createPage(ctx.headers, ctx.open.id, 'target', 'Target page.');
      const pageId = await createPage(ctx.headers, ctx.open.id, 'linking', 'Placeholder.');
      const ghost = randomUUID();
      await editLive(
        pageId,
        `Ghost [[${ghost}]] here.\n\nForeign [[${ctx.otherDocId}]] here.\n\n` +
          `Malformed [[${'-'.repeat(36)}]] here.\n\nReal [[${targetId}]] here.`
      );
      const realBlockId = await blockIdContaining(pageId, 'Real');

      const v1 = await snap(pageId);

      assert.ok(v1, 'snapshot created');
      assert.equal(v1!.number, 1);
      assert.deepEqual(await linkRows(pageId), [
        { fromBlockId: realBlockId, toDocumentId: targetId, kind: 'link' },
      ]);
    });

    test('a link inside a nested child block is recorded with the child block id', async () => {
      const targetId = await createPage(ctx.headers, ctx.open.id, 'target', 'Target page.');
      const pageId = await createPage(ctx.headers, ctx.open.id, 'linking', 'Placeholder.');
      await editLive(pageId, `- Parent item\n    - Child points at [[${targetId}]]\n`);
      const flat = await liveFlatBlocks(pageId);
      const child = flat.find((b) => b.text.includes('Child points at'));
      assert.ok(child, 'child block exists');
      assert.equal(child!.depth, 1, 'the link lives in a nested child block');

      await snap(pageId);

      assert.deepEqual(await linkRows(pageId), [
        { fromBlockId: child!.id, toDocumentId: targetId, kind: 'link' },
      ]);
    });

    test('duplicate links in one block are recorded once; the same target in two blocks twice', async () => {
      const targetId = await createPage(ctx.headers, ctx.open.id, 'target', 'Target page.');
      const pageId = await createPage(ctx.headers, ctx.open.id, 'linking', 'Placeholder.');
      await editLive(
        pageId,
        `First [[${targetId}]] and again [[${targetId}]].\n\nSecond [[${targetId}]].`
      );
      const first = await blockIdContaining(pageId, 'First');
      const second = await blockIdContaining(pageId, 'Second');

      await snap(pageId);

      const expected = [
        { fromBlockId: first, toDocumentId: targetId, kind: 'link' },
        { fromBlockId: second, toDocumentId: targetId, kind: 'link' },
      ].sort((a, b) => a.fromBlockId.localeCompare(b.fromBlockId));
      assert.deepEqual(await linkRows(pageId), expected);
    });

    test('a self-link is dropped', async () => {
      const pageId = await createPage(ctx.headers, ctx.open.id, 'linking', 'Placeholder.');
      await editLive(pageId, `This page is [[${pageId}]].`);

      const v1 = await snap(pageId);

      assert.ok(v1);
      assert.deepEqual(await linkRows(pageId), []);
    });

    test('a later snapshot rebuilds the links', async () => {
      const a = await createPage(ctx.headers, ctx.open.id, 'a', 'A.');
      const b = await createPage(ctx.headers, ctx.open.id, 'b', 'B.');
      const pageId = await createPage(ctx.headers, ctx.open.id, 'linking', 'Placeholder.');
      await editLive(pageId, `Points at [[${a}]].`);
      await snap(pageId);
      await editLive(pageId, `Now points at [[${b}]].`);
      const blockId = await blockIdContaining(pageId, 'Now points at');

      await snap(pageId);

      assert.deepEqual(await linkRows(pageId), [
        { fromBlockId: blockId, toDocumentId: b, kind: 'link' },
      ]);
    });
  });
});
