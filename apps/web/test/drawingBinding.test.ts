import { afterEach, describe, expect, test, vi } from 'vitest';
import * as Y from 'yjs';
import { DRAWINGS_MAP, MAX_DRAWING_ELEMENTS, type DrawingElement } from '@kinote/contracts';
import { bindDrawing, copyDrawing, createDrawing, reconcileByVersion, type SceneApi } from '../src/components/drawing/binding.js';

const el = (id: string, over: Partial<DrawingElement> = {}): DrawingElement => ({ id, index: `a${id}`, version: 1, versionNonce: 1, type: 'rectangle', x: 0, ...over });

/** A stand-in for Excalidraw's API: holds the scene, counts updateScene calls. */
function fakeScene(): SceneApi & { elements: DrawingElement[]; updates: number } {
  const api = {
    elements: [] as DrawingElement[],
    updates: 0,
    getSceneElementsIncludingDeleted: () => api.elements,
    updateScene: ({ elements }: { elements: readonly DrawingElement[] }) => {
      api.elements = [...elements];
      api.updates += 1;
    },
  };
  return api;
}

/** Two page documents kept in sync both ways, as collab would. */
function pair() {
  const a = new Y.Doc();
  const b = new Y.Doc();
  a.on('update', (u: Uint8Array, origin: unknown) => origin !== 'remote' && Y.applyUpdate(b, u, 'remote'));
  b.on('update', (u: Uint8Array, origin: unknown) => origin !== 'remote' && Y.applyUpdate(a, u, 'remote'));
  return { a, b };
}

const bound: Array<{ destroy(): void }> = [];
/** Binds `api` to the drawing; its onChange also puts the elements on the fake canvas, as drawing on Excalidraw's does. */
function bind(doc: Y.Doc, api: SceneApi & { elements: DrawingElement[] }, throttleMs = 0) {
  const b = bindDrawing({ doc, drawingId: 'g1', api, origin: {}, reconcile: reconcileByVersion, throttleMs });
  bound.push(b);
  return {
    ...b,
    onChange(elements: readonly DrawingElement[]) {
      api.elements = [...elements];
      b.onChange(elements);
    },
  };
}
const stored = (doc: Y.Doc) => (doc.getMap<Y.Map<unknown>>(DRAWINGS_MAP).get('g1')?.toJSON() ?? {}) as Record<string, DrawingElement>;

afterEach(() => {
  for (const b of bound.splice(0)) b.destroy();
  vi.useRealTimers();
});

describe('bindDrawing', () => {
  test('a local change reaches the other document', () => {
    const { a, b } = pair();
    const [sa, sb] = [fakeScene(), fakeScene()];
    const ba = bind(a, sa);
    bind(b, sb);
    ba.onChange([el('A')]);
    ba.flush();
    expect(stored(b).A).toEqual(el('A'));
    expect(sb.elements).toEqual([el('A')]);
  });

  test('concurrent edits of different elements both survive', () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    // The drawing was inserted (and its scene created) before both went offline.
    createDrawing(a, 'g1');
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a), 'remote');
    const [sa, sb] = [fakeScene(), fakeScene()];
    const [ba, bb] = [bind(a, sa), bind(b, sb)];
    ba.onChange([el('A')]);
    ba.flush();
    bb.onChange([el('B')]);
    bb.flush();
    // Offline edits meet.
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a), 'remote');
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b), 'remote');
    expect(Object.keys(stored(a)).sort()).toEqual(['A', 'B']);
    expect(sa.elements.map((e) => e.id).sort()).toEqual(['A', 'B']);
    expect(sb.elements.map((e) => e.id).sort()).toEqual(['A', 'B']);
  });

  test('concurrent edits of one element converge to the newer version', () => {
    const { a, b } = pair();
    const [sa, sb] = [fakeScene(), fakeScene()];
    const [ba, bb] = [bind(a, sa), bind(b, sb)];
    ba.onChange([el('A')]);
    ba.flush();
    // Each side edits A while cut off from the other, B with the higher version.
    const a2 = new Y.Doc();
    const b2 = new Y.Doc();
    Y.applyUpdate(a2, Y.encodeStateAsUpdate(a));
    Y.applyUpdate(b2, Y.encodeStateAsUpdate(b));
    const [sa2, sb2] = [fakeScene(), fakeScene()];
    const [ba2, bb2] = [bind(a2, sa2), bind(b2, sb2)];
    ba2.onChange([el('A', { version: 2, versionNonce: 5, x: 1 })]);
    ba2.flush();
    bb2.onChange([el('A', { version: 3, versionNonce: 9, x: 2 })]);
    bb2.flush();
    // Back online: updates flow both ways, including a side's rewrite of the winner.
    a2.on('update', (u: Uint8Array, origin: unknown) => origin !== 'remote' && Y.applyUpdate(b2, u, 'remote'));
    b2.on('update', (u: Uint8Array, origin: unknown) => origin !== 'remote' && Y.applyUpdate(a2, u, 'remote'));
    Y.applyUpdate(b2, Y.encodeStateAsUpdate(a2), 'remote');
    Y.applyUpdate(a2, Y.encodeStateAsUpdate(b2), 'remote');
    ba2.flush();
    bb2.flush();
    expect(stored(a2).A).toMatchObject({ version: 3, x: 2 });
    expect(stored(b2).A).toMatchObject({ version: 3, x: 2 });
    expect(sa2.elements.find((e) => e.id === 'A')).toMatchObject({ version: 3 });
  });

  test('a version tie converges to the lower versionNonce on both sides', () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    const [sa, sb] = [fakeScene(), fakeScene()];
    const [ba, bb] = [bind(a, sa), bind(b, sb)];
    ba.onChange([el('A', { version: 2, versionNonce: 1, x: 1 })]);
    ba.flush();
    bb.onChange([el('A', { version: 2, versionNonce: 7, x: 2 })]);
    bb.flush();
    // Now connected: updates flow both ways, including any rewrite a side makes.
    a.on('update', (u: Uint8Array, origin: unknown) => origin !== 'remote' && Y.applyUpdate(b, u, 'remote'));
    b.on('update', (u: Uint8Array, origin: unknown) => origin !== 'remote' && Y.applyUpdate(a, u, 'remote'));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a), 'remote');
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b), 'remote');
    ba.flush();
    bb.flush();
    expect(stored(a).A).toMatchObject({ versionNonce: 1, x: 1 });
    expect(stored(b).A).toMatchObject({ versionNonce: 1, x: 1 });
    expect(sa.elements.find((e) => e.id === 'A')).toMatchObject({ versionNonce: 1 });
    expect(sb.elements.find((e) => e.id === 'A')).toMatchObject({ versionNonce: 1 });
  });

  test('its own writes do not call updateScene back', () => {
    const doc = new Y.Doc();
    const scene = fakeScene();
    const b = bind(doc, scene);
    b.onChange([el('A')]);
    b.flush();
    b.onChange([el('A')]); // Excalidraw reports the same scene again: nothing to write.
    b.flush();
    expect(scene.updates).toBe(0);
    expect(stored(doc).A).toEqual(el('A'));
  });

  test('a remote update mid-stroke keeps the local in-progress element', () => {
    const { a, b } = pair();
    const [sa, sb] = [fakeScene(), fakeScene()];
    const ba = bind(a, sa, 1000);
    const bb = bind(b, sb);
    bb.onChange([el('A')]);
    bb.flush();
    // A is being dragged on side a: version 5 on its canvas, not yet written.
    sa.elements = [el('A', { version: 5, x: 50 })];
    ba.onChange(sa.elements);
    bb.onChange([el('A', { version: 3, x: 30 })]);
    bb.flush();
    expect(sa.elements.find((e) => e.id === 'A')).toMatchObject({ version: 5, x: 50 });
    ba.flush();
    expect(stored(b).A).toMatchObject({ version: 5, x: 50 });
  });

  test('after a stroke, a canvas copy that lost to the stored one is replaced by it', () => {
    const { a, b } = pair();
    const [sa, sb] = [fakeScene(), fakeScene()];
    // Like Excalidraw while an element is being edited: the local copy is always kept.
    const keepLocal = (local: readonly DrawingElement[], remote: DrawingElement[]) => {
      const ids = new Set(local.map((e) => e.id));
      return [...local, ...remote.filter((e) => !ids.has(e.id))];
    };
    const ba = bindDrawing({ doc: a, drawingId: 'g1', api: sa, origin: {}, reconcile: keepLocal, throttleMs: 1000 });
    bound.push(ba);
    const bb = bind(b, sb);
    bb.onChange([el('A')]);
    bb.flush();
    // a edits A to version 2 while b has already written version 5.
    sa.elements = [el('A', { version: 2, x: 2 })];
    bb.onChange([el('A', { version: 5, x: 5 })]);
    bb.flush();
    expect(sa.elements[0]).toMatchObject({ version: 2 }); // kept while editing
    ba.onChange(sa.elements);
    ba.flush(); // the stroke ends
    expect(sa.elements.find((e) => e.id === 'A')).toMatchObject({ version: 5, x: 5 });
    expect(stored(a).A).toMatchObject({ version: 5 });
  });

  test('a viewer never writes, even when its canvas holds a winning copy', () => {
    const { a, b } = pair();
    const [sa, sb] = [fakeScene(), fakeScene()];
    const viewer = bindDrawing({ doc: a, drawingId: 'g1', api: sa, origin: {}, reconcile: reconcileByVersion, throttleMs: 0, editable: false });
    bound.push(viewer);
    const bb = bind(b, sb);
    sa.elements = [el('A', { version: 9 })];
    bb.onChange([el('A', { version: 2 })]);
    bb.flush();
    viewer.flush();
    expect(stored(b).A).toMatchObject({ version: 2 });
  });

  test('writes are throttled and flush writes at once', () => {
    vi.useFakeTimers();
    const doc = new Y.Doc();
    const writes: number[] = [];
    doc.on('update', () => writes.push(1));
    const b = bind(doc, fakeScene(), 50);
    b.onChange([el('A')]);
    b.onChange([el('A', { version: 2 })]);
    b.onChange([el('A', { version: 3 })]);
    expect(writes).toHaveLength(0);
    vi.advanceTimersByTime(50);
    expect(writes).toHaveLength(1);
    expect(stored(doc).A).toMatchObject({ version: 3 });
    b.onChange([el('A', { version: 4 })]);
    b.flush();
    expect(writes).toHaveLength(2);
  });

  test('past 5,000 live elements new elements are not written', () => {
    const doc = new Y.Doc();
    const b = bind(doc, fakeScene());
    const many = Array.from({ length: MAX_DRAWING_ELEMENTS }, (_, i) => el(`e${i}`, { index: `a${String(i).padStart(5, '0')}` }));
    b.onChange(many);
    b.flush();
    expect(b.full()).toBe(true);
    b.onChange([...many, el('extra')]);
    b.flush();
    expect(stored(doc).extra).toBeUndefined();
    // Existing elements still change.
    b.onChange([el('e0', { index: 'a00000', version: 2 })]);
    b.flush();
    expect(stored(doc).e0).toMatchObject({ version: 2 });
  });

  test('viewing a drawing never writes to the page', () => {
    const doc = new Y.Doc();
    const writes: number[] = [];
    doc.on('update', () => writes.push(1));
    const b = bind(doc, fakeScene());
    b.onChange([]);
    b.flush();
    b.destroy();
    expect(writes).toHaveLength(0);
  });

  test('an element Excalidraw changes in place after a write still reaches the other document', () => {
    const { a, b } = pair();
    const ba = bind(a, fakeScene());
    bind(b, fakeScene());
    // Excalidraw's mutateElement edits the same object while a shape is dragged out.
    const shape: DrawingElement = el('A', { width: 10 });
    ba.onChange([shape]);
    ba.flush();
    shape.width = 80;
    shape.version = 2;
    ba.onChange([shape]);
    ba.flush();
    expect(stored(b).A).toMatchObject({ width: 80, version: 2 });
  });

  test('a remote element on the canvas is not the stored copy', () => {
    const { a, b } = pair();
    const ba = bind(a, fakeScene());
    const sb = fakeScene();
    const bb = bind(b, sb);
    ba.onChange([el('A', { width: 10 })]);
    ba.flush();
    // Bea's canvas then moves it in place, as Excalidraw does.
    const onCanvas = sb.elements.find((e) => e.id === 'A')!;
    onCanvas.width = 80;
    onCanvas.version = 2;
    bb.onChange(sb.elements);
    bb.flush();
    expect(stored(a).A).toMatchObject({ width: 80, version: 2 });
  });
});

describe('createDrawing', () => {
  test('makes the empty scene once; a second call keeps what is there', () => {
    const doc = new Y.Doc();
    createDrawing(doc, 'g1');
    const scene = doc.getMap<Y.Map<unknown>>(DRAWINGS_MAP).get('g1')!;
    scene.set('A', el('A'));
    createDrawing(doc, 'g1');
    expect(doc.getMap<Y.Map<unknown>>(DRAWINGS_MAP).get('g1')!.get('A')).toEqual(el('A'));
  });
});

describe('copyDrawing', () => {
  test('copyDrawing gives the copy its own elements', () => {
    const doc = new Y.Doc();
    const b = bind(doc, fakeScene());
    b.onChange([el('A'), el('gone', { isDeleted: true })]);
    b.flush();
    copyDrawing(doc, 'g1', 'g2');
    const root = doc.getMap<Y.Map<unknown>>(DRAWINGS_MAP);
    expect(Object.keys(root.get('g2')!.toJSON())).toEqual(['A']);
    b.onChange([el('A', { version: 2, x: 9 })]);
    b.flush();
    expect(root.get('g2')!.get('A')).toMatchObject({ version: 1, x: 0 });
  });
});
