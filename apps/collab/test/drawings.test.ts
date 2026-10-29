import { describe, test, beforeAll, afterEach, afterAll, expect } from 'vitest';
import * as Y from 'yjs';
import { DRAWINGS_MAP, newerElement, type DrawingElement } from '@kinote/contracts';
import { HttpCollabClient, createServerEditor } from '@kinote/shared';
import { changedBlockIds, changesPage, collabSettle, type CollabServer } from '../src/server.js';
import { MAX_INTERNAL_BODY_BYTES } from '../src/internal.js';
import { guardDrawings } from '../src/drawingGuard.js';
import { buildCollabWorld, storedDoc, TEST_INTERNAL_SECRET } from './support/collabWorld.js';
import { startCollabServer } from './support/wsClient.js';
import { buildTestApp, useTestDb } from '../../api/test/support/testkit.js';

const editor = createServerEditor();
const el = (id: string, over: Partial<DrawingElement> = {}): DrawingElement => ({ id, index: `a${id}`, version: 1, versionNonce: 1, type: 'rectangle', ...over });
const drawingBlock = (id: string, drawingId: string) => ({ id, type: 'drawing', props: { drawingId, title: 'Flow' }, children: [] });
const paragraph = (id: string, text: string) => ({ id, type: 'paragraph', content: text, children: [] });

/** A scene's element map in a page document, created if missing. */
function scene(doc: Y.Doc, drawingId: string): Y.Map<unknown> {
  const drawings = doc.getMap<Y.Map<unknown>>(DRAWINGS_MAP);
  let map = drawings.get(drawingId);
  if (!map) {
    map = new Y.Map();
    drawings.set(drawingId, map);
  }
  return map;
}

function seen(doc: Y.Doc, fn: () => void) {
  const out: Array<{ changes: boolean; ids: string[] }> = [];
  const listener = (tx: Y.Transaction) => out.push({ changes: changesPage(tx), ids: changedBlockIds(tx).sort() });
  doc.on('afterTransaction', listener);
  try {
    fn();
  } finally {
    doc.off('afterTransaction', listener);
  }
  return out;
}

describe('drawing changes are page changes', () => {
  test('a change inside a drawing is attributed to its drawing block', () => {
    const doc = editor.blocksToYDoc([paragraph('p1', 'Intro'), drawingBlock('d1', 'g1')] as any, 'document-store');
    // Creating the scene, then editing an element inside it.
    expect(seen(doc, () => doc.transact(() => scene(doc, 'g1').set('a', el('a'))))).toEqual([{ changes: true, ids: ['d1'] }]);
    expect(seen(doc, () => doc.transact(() => scene(doc, 'g1').set('a', el('a', { version: 2 }))))).toEqual([{ changes: true, ids: ['d1'] }]);
  });

  test('a change to a drawing no block references still marks the page changed', () => {
    const doc = editor.blocksToYDoc([paragraph('p1', 'Intro')] as any, 'document-store');
    expect(seen(doc, () => doc.transact(() => scene(doc, 'orphan').set('a', el('a'))))).toEqual([{ changes: true, ids: [] }]);
  });
});

describe('the server keeps the newer element', () => {
  for (const order of ['server first', 'client first'] as const) {
    test(`a stale client edit can't bring back a restored-away shape (${order} clientID)`, () => {
      const server = new Y.Doc();
      const client = new Y.Doc();
      // Yjs settles concurrent writes to one key by clientID: try both orders.
      server.clientID = order === 'server first' ? 2 : 1;
      client.clientID = order === 'server first' ? 1 : 2;
      guardDrawings(server);
      scene(server, 'g1').set('B', el('B', { version: 3 }));
      Y.applyUpdate(client, Y.encodeStateAsUpdate(server));
      // Offline: the server restores (B tombstoned at 6), the client edits B to 4.
      server.transact(() => scene(server, 'g1').set('B', el('B', { version: 6, isDeleted: true })));
      client.transact(() => scene(client, 'g1').set('B', el('B', { version: 4, x: 9 })));
      // Back online, updates both ways (the server's repair travels too).
      server.on('update', (u: Uint8Array, origin: unknown) => origin !== 'remote' && Y.applyUpdate(client, u, 'remote'));
      Y.applyUpdate(server, Y.encodeStateAsUpdate(client), 'remote');
      Y.applyUpdate(client, Y.encodeStateAsUpdate(server), 'remote');
      for (const doc of [server, client]) {
        expect(scene(doc, 'g1').get('B')).toMatchObject({ version: 6, isDeleted: true });
      }
    });
  }

  test('a newer remote edit is kept', () => {
    const server = new Y.Doc();
    guardDrawings(server);
    scene(server, 'g1').set('A', el('A', { version: 2 }));
    const client = new Y.Doc();
    Y.applyUpdate(client, Y.encodeStateAsUpdate(server));
    client.transact(() => scene(client, 'g1').set('A', el('A', { version: 5, x: 3 })));
    Y.applyUpdate(server, Y.encodeStateAsUpdate(client), 'remote');
    expect(scene(server, 'g1').get('A')).toMatchObject({ version: 5, x: 3 });
  });
});

describe('restoring drawings', () => {
  const app = buildTestApp();
  let server: CollabServer;
  let collab: HttpCollabClient;

  beforeAll(async () => {
    ({ server } = await startCollabServer(undefined, { debounceMs: 60_000, maxDebounceMs: 60_000 }));
    collab = new HttpCollabClient(`http://127.0.0.1:${server.server.address.port}`, TEST_INTERNAL_SECRET);
  });
  useTestDb();
  afterEach(async () => {
    await collabSettle(server);
  });
  afterAll(async () => {
    await server.server.destroy();
  });

  async function withScene() {
    const w = await buildCollabWorld(app);
    const actor = { type: 'user' as const, id: w.owner.userId };
    const blocks = [drawingBlock('d1', 'g1')];
    // The live scene: A at version 3, B at version 1 (B was added after the version being restored).
    await collab.replaceBlocks({
      tenantId: w.tenant.id, pageId: w.pageA.id, title: 'Page A', blocks, actor, source: 'restore',
      drawings: { g1: [el('A', { version: 3, x: 30 }), el('B')] },
    });
    return { w, actor, blocks };
  }

  test('replace-blocks with drawings restores the elements and tombstones the rest', async () => {
    const { w, actor, blocks } = await withScene();
    const sceneOf = async () => (await storedDoc(w.tenant.id, w.pageA.id)).getMap<Y.Map<unknown>>(DRAWINGS_MAP).get('g1')!;
    const before = await sceneOf();
    const [a, b] = [before.get('A') as DrawingElement, before.get('B') as DrawingElement];
    await collab.replaceBlocks({
      tenantId: w.tenant.id, pageId: w.pageA.id, title: 'Page A', blocks, actor, source: 'restore',
      drawings: { g1: [el('A', { version: 2, x: 20 })] },
    });
    const live = await sceneOf();
    // The restored element must win over what open editors hold, so its version moves past the live one.
    expect(live.get('A')).toMatchObject({ id: 'A', x: 20, isDeleted: false, version: a.version + 1 });
    expect(live.get('B')).toMatchObject({ id: 'B', isDeleted: true, version: b.version + 1 });
  });

  test('a stale client write after a restore loses to the tombstone', async () => {
    const { w, actor, blocks } = await withScene();
    await collab.replaceBlocks({ tenantId: w.tenant.id, pageId: w.pageA.id, title: 'Page A', blocks, actor, source: 'restore', drawings: { g1: [] } });
    const live = (await storedDoc(w.tenant.id, w.pageA.id)).getMap<Y.Map<unknown>>(DRAWINGS_MAP).get('g1')!;
    const tombstone = live.get('B') as DrawingElement;
    expect(newerElement(tombstone, el('B'))).toBe(tombstone);
  });

  test('drawings left out of the payload are left alone', async () => {
    const { w, actor, blocks } = await withScene();
    await collab.replaceBlocks({ tenantId: w.tenant.id, pageId: w.pageA.id, title: 'Page A', blocks, actor, source: 'restore', drawings: {} });
    const live = (await storedDoc(w.tenant.id, w.pageA.id)).getMap<Y.Map<unknown>>(DRAWINGS_MAP).get('g1')!;
    expect(live.get('B')).toMatchObject({ isDeleted: false });
  });

  test('the internal body limit fits a page at the drawing limits', () => {
    expect(MAX_INTERNAL_BODY_BYTES).toBe(8 * 1024 * 1024);
  });
});
