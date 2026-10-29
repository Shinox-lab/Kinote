import type { BlockDiffEntry } from '@kinote/contracts';
import { changeLabel, changedEntries, type ChangeKind } from '../lib/diff.js';

const TONE: Record<ChangeKind, string> = {
  added: 'border-diff-added-line bg-diff-added',
  changed: 'border-diff-changed-line bg-diff-changed',
  removed: 'border-diff-removed-line bg-diff-removed',
};

const HEADING: Record<number, string> = {
  1: 'text-[22px] font-semibold leading-tight',
  2: 'text-[19px] font-semibold leading-tight',
  3: 'text-[16px] font-semibold leading-snug',
};

function text(value: string | undefined): string {
  return value || '(empty block)';
}

/** One block's text, shaped by its type; inline bold/links/table cells are plain text by design. */
function BlockText({ entry, text: value, marker }: { entry: BlockDiffEntry; text: string; marker?: string }) {
  const type = entry.type;
  if (type === 'heading') {
    return <p className={HEADING[entry.level ?? 1] ?? 'text-[15.5px] font-semibold'}>{value}</p>;
  }
  if (type === 'quote') {
    return <p className="border-l-2 border-line pl-3 text-[15.5px] italic leading-[1.72] text-muted">{value}</p>;
  }
  if (type === 'codeBlock') {
    return (
      <pre className="overflow-x-auto rounded-md border border-line bg-sidebar px-3 py-2 font-mono text-[12.5px] leading-relaxed">
        {value}
      </pre>
    );
  }
  if (type === 'table') {
    return (
      <pre className="overflow-x-auto rounded-md border border-line bg-surface px-3 py-2 text-[12.5px] leading-relaxed">
        {value}
      </pre>
    );
  }
  if (type === 'bulletListItem' || type === 'numberedListItem') {
    return (
      <p className="text-[15.5px] leading-[1.72]" style={{ paddingLeft: `${(entry.depth ?? 0) * 18}px` }}>
        <span aria-hidden="true" className="mr-2 text-muted">
          {type === 'numberedListItem' ? (marker ?? '1.') : '•'}
        </span>
        {value}
      </p>
    );
  }
  return (
    <p className="text-[15.5px] leading-[1.72]" style={{ paddingLeft: `${(entry.depth ?? 0) * 18}px` }}>
      {value}
    </p>
  );
}

/**
 * A whole version as typed blocks, every block in place with its change tone:
 * unchanged plain, added green, changed violet with the old line struck, and
 * removed red. The full-document view for a page review; `DiffView` is the
 * changes-only view.
 */
export function ReviewDocument({ entries, label }: { entries: readonly BlockDiffEntry[]; label: string }) {
  const changes = changedEntries(entries);
  const counters: Record<number, number> = {};
  return (
    <div className="flex flex-col gap-3">
      {changes.length === 0 && <p className="text-xs text-muted">No block changes.</p>}
      <ul aria-label={label} className="flex flex-col gap-1.5">
        {entries.map((entry, index) => {
          const kind = entry.change;
          let marker: string | undefined;
          if (entry.type === 'numberedListItem') {
            const depth = entry.depth ?? 0;
            counters[depth] = (counters[depth] ?? 0) + 1;
            marker = `${counters[depth]}.`;
          }
          const tone = kind === 'unchanged' ? '' : `border-l-2 ${TONE[kind]}`;
          return (
            <li key={`${entry.blockId}-${kind}-${index}`} className={`rounded-r-md px-2 py-1 ${tone}`}>
              {kind !== 'unchanged' && (
                <p className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted">
                  {changeLabel(kind)}
                </p>
              )}
              {kind === 'changed' && (
                <div className="text-muted line-through">
                  <BlockText entry={entry} text={text(entry.before)} marker={marker} />
                </div>
              )}
              <BlockText entry={entry} text={text(kind === 'removed' ? entry.before : entry.after)} marker={marker} />
            </li>
          );
        })}
      </ul>
    </div>
  );
}
