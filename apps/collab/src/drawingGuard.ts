import * as Y from 'yjs';
import { DRAWINGS_MAP, isDrawingElement, newerElement } from '@kinote/contracts';

/** The origin of the guard's own repairs: no actor, so they are never attributed. */
const REPAIR = Symbol('drawing-guard');

/**
 * Keeps Excalidraw's merge rule on the server's copy of a page (D2): when a
 * change replaces a drawing element with one that loses to it by
 * `newerElement` (Yjs settles concurrent writes by client id, not by
 * element version), the older-but-winning value is written back. Its repair
 * reaches every client, so a stale edit can never bring back a shape a
 * restore or another person's later edit replaced, even when no open canvas
 * holds the winner.
 */
export function guardDrawings(doc: Y.Doc): void {
  const root = doc.getMap<unknown>(DRAWINGS_MAP);
  root.observeDeep((events, tx) => {
    if (tx.origin === REPAIR) return;
    const repairs: Array<[Y.Map<unknown>, string, unknown]> = [];
    for (const event of events) {
      if (!(event instanceof Y.YMapEvent) || !(event.target instanceof Y.Map) || event.target === root) continue;
      const scene = event.target as Y.Map<unknown>;
      for (const [key, change] of event.changes.keys) {
        if (change.action !== 'update') continue;
        const before = change.oldValue;
        const now = scene.get(key);
        if (!isDrawingElement(before) || !isDrawingElement(now)) continue;
        if (newerElement(before, now) === before && (before.version !== now.version || before.versionNonce !== now.versionNonce)) {
          repairs.push([scene, key, before]);
        }
      }
    }
    if (repairs.length === 0) return;
    doc.transact(() => {
      for (const [scene, key, value] of repairs) scene.set(key, value);
    }, REPAIR);
  });
}
