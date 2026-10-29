import { Suspense, lazy } from 'react';
import type { BlockDiffEntry } from '@kinote/contracts';
import { drawingChangeText } from '../../lib/diff.js';

const DrawingPreview = lazy(() => import('./DrawingPreview.js'));

/**
 * A drawing in a diff (D8): the shapes added, changed and removed, and the
 * drawing before and after side by side (after only when added, before only
 * when removed, one picture when unchanged).
 */
export function DrawingChange({ entry }: { entry: BlockDiffEntry & { drawing: NonNullable<BlockDiffEntry['drawing']> } }) {
  const d = entry.drawing;
  const sides: Array<{ label: string; version: number | null }> =
    entry.change === 'added'
      ? [{ label: 'Drawing', version: d.afterVersion }]
      : entry.change === 'removed'
        ? [{ label: 'Drawing', version: d.beforeVersion }]
        : entry.change === 'unchanged'
          ? [{ label: 'Drawing', version: d.afterVersion }]
          : [
              { label: 'Before', version: d.beforeVersion },
              { label: 'After', version: d.afterVersion },
            ];
  return (
    <div className="flex flex-col gap-1">
      {entry.change !== 'unchanged' && <p className="text-xs text-muted">{drawingChangeText(d)}</p>}
      <div className={`grid gap-2 ${sides.length === 2 ? 'grid-cols-1 sm:grid-cols-2' : 'grid-cols-1'}`}>
        {sides.map((side) => (
          <figure key={side.label} className="flex min-w-0 flex-col gap-0.5">
            {sides.length === 2 && <figcaption className="text-[10px] font-semibold uppercase tracking-wide text-muted">{side.label}</figcaption>}
            <Suspense fallback={<div className="h-16 rounded border border-[var(--border)]" />}>
              <DrawingPreview pageId={d.pageId} drawingId={d.drawingId} version={side.version} label={`${side.label} drawing`} />
            </Suspense>
          </figure>
        ))}
      </div>
    </div>
  );
}
