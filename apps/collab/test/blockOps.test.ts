import { describe, test, beforeAll, afterAll, expect } from 'vitest';
import * as Y from 'yjs';
import { and, eq } from 'drizzle-orm';
import { withTenantTx, blockActivity } from '@living-wiki/db';
import { AppError } from '@living-wiki/contracts';
import { applyBlockOps } from '../src/blockOps.js';
import type { CollabServer } from '../src/server.js';
import { startCollabServer } from './support/wsClient.js';
import { BLOCK_FRAGMENT, readBlocks, writeBlocks } from './support/blocks.js';
import { buildCollabWorld, storedDoc, TEST_INTERNAL_SECRET } from './support/collabWorld.js';
import { buildTestApp, useTestDb } from '../../api/test/support/testkit.js';

function paragraph(id: string, text: string) {
  return { id, type: 'paragraph', props: {}, content: [{ type: 'text', text, styles: {} }], children: [] };
}

function seeded(): Y.Doc {
  const doc = new Y.Doc();
  writeBlocks(doc, [
    { id: 'a', type: 'paragraph', text: 'A' },
    { id: 'b', type: 'paragraph', text: 'B' },
    { id: 'c', type: 'paragraph', text: 'C' },
  ]);
  return doc;
}

function texts(doc: Y.Doc): string[] {
  return readBlocks(doc).map((b) => b.content.map((c: any) => c.text).join(''));
}

describe('applyBlockOps', () => {
  test('inserts after a block, keeping the new id', () => {
    const doc = seeded();
    applyBlockOps(doc.getXmlFragment(BLOCK_FRAGMENT), [
      { op: 'insert_after', after: 'b', blocks: [paragraph('n', 'new')] },
    ]);
    expect(texts(doc)).toEqual(['A', 'B', 'new', 'C']);
    expect(readBlocks(doc)[2].id).toBe('n');
  });

  test('inserts at the start when after is null', () => {
    const doc = seeded();
    applyBlockOps(doc.getXmlFragment(BLOCK_FRAGMENT), [
      { op: 'insert_after', after: null, blocks: [paragraph('n', 'first')] },
    ]);
    expect(texts(doc)).toEqual(['first', 'A', 'B', 'C']);
  });

  test('replaces a block, the first new block keeping its id', () => {
    const doc = seeded();
    applyBlockOps(doc.getXmlFragment(BLOCK_FRAGMENT), [
      { op: 'replace', blockId: 'b', blocks: [paragraph('ignored', "B'"), paragraph('x', 'extra')] },
    ]);
    expect(texts(doc)).toEqual(['A', "B'", 'extra', 'C']);
    expect(readBlocks(doc).map((b) => b.id)).toEqual(['a', 'b', 'x', 'c']);
  });

  test('removes a block', () => {
    const doc = seeded();
    applyBlockOps(doc.getXmlFragment(BLOCK_FRAGMENT), [{ op: 'remove', blockId: 'b' }]);
    expect(texts(doc)).toEqual(['A', 'C']);
  });

  test('an unknown block id throws block_not_found and changes nothing', () => {
    const doc = seeded();
    let err: unknown;
    try {
      applyBlockOps(doc.getXmlFragment(BLOCK_FRAGMENT), [
        { op: 'remove', blockId: 'a' },
        { op: 'replace', blockId: 'zzz', blocks: [paragraph('q', 'q')] },
      ]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe('block_not_found');
    expect(texts(doc)).toEqual(['A', 'B', 'C']);
  });
});

describe('POST /internal/apply-block-ops', () => {
  const app = buildTestApp();
  let server: CollabServer;
  let port: number;

  beforeAll(async () => {
    ({ server, port } = await startCollabServer(undefined, { debounceMs: 60_000, maxDebounceMs: 60_000 }));
  });
  useTestDb();
  afterAll(async () => {
    await server.server.destroy();
  });

  function call(json: unknown) {
    return fetch(`http://127.0.0.1:${port}/internal/apply-block-ops`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-secret': TEST_INTERNAL_SECRET },
      body: JSON.stringify(json),
    });
  }

  test('two ops in one call land as one agent change on both blocks', async () => {
    const w = await buildCollabWorld(app);
    const before = readBlocks(await storedDoc(w.tenant.id, w.pageA.id));
    const headingId = before[0].id as string;
    const res = await call({
      documentName: w.docName(w.pageA.id),
      actor: { type: 'agent', id: w.agentId },
      source: 'agent',
      ops: [
        { op: 'insert_after', after: headingId, blocks: [paragraph('n1', 'Billing uses Adyen.')] },
        { op: 'replace', blockId: headingId, blocks: [paragraph('ignored', 'Heading replaced')] },
      ],
    });
    expect(res.status).toBe(204);
    const stored = readBlocks(await storedDoc(w.tenant.id, w.pageA.id));
    expect(stored.map((b) => b.id)).toEqual([headingId, 'n1']);
    const rows = await withTenantTx(w.tenant.id, (tx) =>
      tx.select().from(blockActivity).where(and(eq(blockActivity.tenantId, w.tenant.id), eq(blockActivity.pageId, w.pageA.id)))
    );
    const byBlock = new Map(rows.map((r) => [r.blockId, r]));
    expect(byBlock.get('n1')?.actorType).toBe('agent');
    expect(byBlock.get(headingId)?.actorType).toBe('agent');
  });

  test('an unknown block is 404 block_not_found', async () => {
    const w = await buildCollabWorld(app);
    const res = await call({
      documentName: w.docName(w.pageA.id),
      actor: { type: 'agent', id: w.agentId },
      source: 'agent',
      ops: [{ op: 'remove', blockId: 'nope' }],
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'block_not_found' });
  });

  test('a human change must be made by a user', async () => {
    const w = await buildCollabWorld(app);
    const res = await call({
      documentName: w.docName(w.pageA.id),
      actor: { type: 'agent', id: w.agentId },
      source: 'human',
      ops: [{ op: 'remove', blockId: 'x' }],
    });
    expect(res.status).toBe(400);
  });
});
