import * as Y from 'yjs';
import {
  DRAWINGS_MAP,
  MAX_DRAWING_BYTES,
  MAX_DRAWING_ELEMENTS,
  isDrawingElement,
  newerElement,
  type DrawingElement,
} from '@kinote/contracts';

// The live binding between one Excalidraw canvas and its scene in the page
// document (spec D2–D4): the `drawings` map holds drawingId → Y.Map(elementId
// → element). One map entry per element is what lets two people draw at once;
// the same element edited twice keeps the newer one by Excalidraw's own rule.

/** The part of Excalidraw's API the binding uses. */
export interface SceneApi {
  getSceneElementsIncludingDeleted(): readonly DrawingElement[];
  updateScene(scene: { elements: readonly DrawingElement[] }): void;
}

/** Merges remote elements into the local scene: per id, the newer by `newerElement`. Excalidraw's `reconcileElements` does the same in the app. */
export function reconcileByVersion(local: readonly DrawingElement[], remote: DrawingElement[]): DrawingElement[] {
  const out = new Map(local.map((e) => [e.id, e]));
  for (const e of remote) {
    const mine = out.get(e.id);
    out.set(e.id, mine ? newerElement(mine, e) : e);
  }
  return [...out.values()];
}

function sceneOf(doc: Y.Doc, drawingId: string): Y.Map<unknown> | undefined {
  const scene = doc.getMap<unknown>(DRAWINGS_MAP).get(drawingId);
  return scene instanceof Y.Map ? (scene as Y.Map<unknown>) : undefined;
}

const same = (a: DrawingElement, b: DrawingElement) => a.version === b.version && a.versionNonce === b.versionNonce;

/**
 * Keeps an Excalidraw canvas and its scene in the page document in step.
 * `onChange` (Excalidraw's) writes elements that differ from the stored
 * ones and win over them, at most one transaction per `throttleMs` (with
 * `origin`); `flush` writes now. Changes from anyone else are merged into
 * the canvas with `reconcile`; where the canvas holds a winning copy (an
 * edit in progress, or a tie the other side lost), it is written back so
 * every side ends up with the same element. Past MAX_DRAWING_ELEMENTS live
 * elements or MAX_DRAWING_BYTES, new elements are not written (`full`).
 * Nothing is written until something is drawn.
 */
export function bindDrawing(opts: {
  doc: Y.Doc;
  drawingId: string;
  api: SceneApi;
  origin: object;
  reconcile: (local: readonly DrawingElement[], remote: DrawingElement[]) => DrawingElement[];
  throttleMs?: number;
}): { onChange(elements: readonly DrawingElement[]): void; flush(): void; destroy(): void; full: () => boolean } {
  const { doc, drawingId, api, origin, reconcile } = opts;
  const throttleMs = opts.throttleMs ?? 50;
  const pending = new Map<string, DrawingElement>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let isFull = false;

  /** Queues `e` when it differs from the stored copy and wins over it. */
  const queue = (e: DrawingElement) => {
    const stored = sceneOf(doc, drawingId)?.get(e.id);
    if (isDrawingElement(stored) && (same(stored, e) || newerElement(stored, e) === stored)) return;
    const waiting = pending.get(e.id);
    pending.set(e.id, waiting ? newerElement(waiting, e) : e);
  };
  const schedule = () => {
    if (pending.size === 0 || timer) return;
    timer = setTimeout(() => {
      timer = null;
      flush();
    }, throttleMs);
  };

  const measure = (scene: Y.Map<unknown> | undefined) => {
    if (!scene) return { live: 0, bytes: 0 };
    let live = 0;
    let bytes = 0;
    for (const value of scene.values()) {
      if (!isDrawingElement(value) || value.isDeleted) continue;
      live += 1;
      bytes += JSON.stringify(value).length;
    }
    return { live, bytes };
  };

  function flush() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (pending.size === 0) return;
    const list = [...pending.values()];
    pending.clear();
    doc.transact(() => {
      const root = doc.getMap<unknown>(DRAWINGS_MAP);
      // Normally made when the block was inserted (createDrawing); made here only for a block that has none.
      let scene = sceneOf(doc, drawingId);
      if (!scene) {
        scene = new Y.Map<unknown>();
        root.set(drawingId, scene);
      }
      let { live, bytes } = measure(scene);
      for (const e of list) {
        const isNew = !scene.has(e.id);
        if (isNew && !e.isDeleted && (live >= MAX_DRAWING_ELEMENTS || bytes >= MAX_DRAWING_BYTES)) continue;
        scene.set(e.id, e);
        if (isNew && !e.isDeleted) {
          live += 1;
          bytes += JSON.stringify(e).length;
        }
      }
      isFull = live >= MAX_DRAWING_ELEMENTS || bytes >= MAX_DRAWING_BYTES;
    }, origin);
  }

  const onRemote = (events: Array<Y.YEvent<any>>, tx: Y.Transaction) => {
    if (tx.origin === origin) return;
    const scene = sceneOf(doc, drawingId);
    if (!scene) return;
    const changed: DrawingElement[] = [];
    for (const event of events) {
      if (!(event instanceof Y.YMapEvent)) continue;
      if (event.target === scene) {
        for (const key of event.keysChanged) {
          const value = scene.get(key);
          if (isDrawingElement(value)) changed.push(value);
        }
      } else if (event.target === doc.getMap(DRAWINGS_MAP) && event.keysChanged.has(drawingId)) {
        for (const value of scene.values()) if (isDrawingElement(value)) changed.push(value);
      }
    }
    if (changed.length === 0) return;
    const merged = reconcile(api.getSceneElementsIncludingDeleted(), changed);
    api.updateScene({ elements: merged });
    // Where the canvas kept its own copy, write it back so both sides agree.
    const byId = new Map(merged.map((e) => [e.id, e]));
    for (const remote of changed) {
      const mine = byId.get(remote.id);
      if (mine && !same(mine, remote) && newerElement(mine, remote) === mine) queue(mine);
    }
    schedule();
    isFull = (() => {
      const m = measure(scene);
      return m.live >= MAX_DRAWING_ELEMENTS || m.bytes >= MAX_DRAWING_BYTES;
    })();
  };
  const root = doc.getMap<unknown>(DRAWINGS_MAP);
  root.observeDeep(onRemote);

  return {
    onChange(elements) {
      for (const e of elements) if (isDrawingElement(e)) queue(e);
      schedule();
    },
    flush,
    destroy() {
      flush();
      root.unobserveDeep(onRemote);
    },
    full: () => isFull,
  };
}

/**
 * Makes a new drawing's empty scene, when the block is inserted. Only the
 * inserting client makes it, so two people's first strokes land in the same
 * map: two maps made at once under one key would keep only one of them.
 */
export function createDrawing(doc: Y.Doc, drawingId: string): void {
  if (sceneOf(doc, drawingId)) return;
  doc.getMap<unknown>(DRAWINGS_MAP).set(drawingId, new Y.Map<unknown>());
}

/** Gives drawing `toId` its own copy of `fromId`'s live elements (a duplicated or pasted drawing block). */
export function copyDrawing(doc: Y.Doc, fromId: string, toId: string): void {
  const from = sceneOf(doc, fromId);
  doc.transact(() => {
    const copy = new Y.Map<unknown>();
    doc.getMap<unknown>(DRAWINGS_MAP).set(toId, copy);
    for (const [id, value] of from?.entries() ?? []) {
      if (isDrawingElement(value) && !value.isDeleted) copy.set(id, { ...value });
    }
  });
}
