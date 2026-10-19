import type { BlockDiffEntry } from '@living-wiki/contracts';
import { changeLabel, changedEntries, diffSummary, type Change } from '../lib/diff.js';
import { useAuthorNames } from '../lib/queries.js';
import { authorLabel } from '../lib/wiki.js';

const TONE = {
  added: 'border-emerald-500 bg-emerald-50',
  changed: 'border-amber-500 bg-amber-50',
  removed: 'border-red-500 bg-red-50',
} as const;

const text = (value: string | undefined) => value || '(empty block)';

function Entry({ entry, names, selfId }: { entry: Change; names: Map<string, string>; selfId: string | null }) {
  const who = entry.author ? authorLabel(entry.author, names, selfId) : null;
  return (
    <li className={`rounded-md border-l-4 px-3 py-2 text-sm ${TONE[entry.change]}`}>
      <p className="mb-1 flex flex-wrap items-center gap-x-2 text-xs font-medium text-slate-800">
        <span>{changeLabel(entry.change)}</span>
        {who && (
          <>
            <span aria-hidden="true">·</span>
            <span>{who.name}</span>
            {who.isAgent && <span className="rounded bg-slate-800 px-1.5 text-[10px] uppercase tracking-wide text-white">Agent</span>}
          </>
        )}
      </p>
      {/* Block text is rendered as React text children only: it is page content, never markup. */}
      {entry.change === 'changed' && <p className="whitespace-pre-wrap break-words text-slate-500 line-through">{text(entry.before)}</p>}
      <p className="whitespace-pre-wrap break-words text-slate-900">{text(entry.change === 'removed' ? entry.before : entry.after)}</p>
    </li>
  );
}

/** The added, changed and removed blocks of a diff, with a one-line count above them. Shared by review items and compare. */
export function DiffView({ entries, label }: { entries: readonly BlockDiffEntry[]; label: string }) {
  const { names, selfId } = useAuthorNames();
  const changes = changedEntries(entries);
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs font-medium text-slate-600">{diffSummary(entries)}</p>
      {changes.length > 0 && (
        <ul aria-label={label} className="flex flex-col gap-2">
          {changes.map((entry, i) => (
            <Entry key={`${entry.blockId}-${entry.change}-${i}`} entry={entry} names={names} selfId={selfId} />
          ))}
        </ul>
      )}
    </div>
  );
}
