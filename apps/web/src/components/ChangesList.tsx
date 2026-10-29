import type { BlockDiffEntry } from '@kinote/contracts';
import { usePageChanges } from '../lib/queries.js';
import { loadSession } from '../lib/session.js';
import { authorColor, authorLabel, visibleChanges } from '../lib/wiki.js';
import { ErrorNote } from './ui.js';

const CHANGE_WORD = { added: 'Added', changed: 'Changed', removed: 'Removed' } as const;

/** A diff entry that is not `unchanged`. */
type Change = BlockDiffEntry & { change: keyof typeof CHANGE_WORD };

function Entry({ entry, selfId }: { entry: Change; selfId: string | null }) {
  const color = entry.author ? authorColor(entry.author.id) : null;
  const who = entry.author ? authorLabel(entry.author, new Map(), selfId) : null;
  return (
    <li
      className="rounded-md border-l-[3px] px-2.5 py-1.5 text-xs"
      style={{ borderLeftColor: color?.accent ?? 'var(--muted)', backgroundColor: color?.tint ?? 'var(--hover)' }}
    >
      <p className="mb-0.5 flex flex-wrap items-center gap-x-1.5 font-medium text-fg">
        <span>{CHANGE_WORD[entry.change]}</span>
        {who && (
          <>
            <span aria-hidden="true">·</span>
            <span aria-hidden="true" className="size-2 rounded-full" style={{ backgroundColor: color?.accent }} />
            <span>{who.name}</span>
            {who.isAgent && (
              <span className="rounded border border-line px-1 text-[10px] uppercase tracking-wide text-muted">Agent</span>
            )}
          </>
        )}
      </p>
      {entry.change === 'changed' && entry.before !== undefined && (
        <p className="break-words text-muted line-through">{entry.before || '(empty block)'}</p>
      )}
      <p className="whitespace-pre-wrap break-words text-fg">
        {(entry.change === 'removed' ? entry.before : entry.after) || '(empty block)'}
      </p>
    </li>
  );
}

/**
 * What changed since the indexed version, each block washed in its author's
 * colour and labelled with their name (the server sends the name for every
 * role). The same colours mark the blocks in the page itself.
 */
export function ChangesList({ pageId }: { pageId: string }) {
  const { data: entries, error, isPending } = usePageChanges(pageId);
  const selfId = loadSession()?.user.id ?? null;
  const changed = visibleChanges(entries ?? []) as Change[];

  if (isPending) return <p className="text-xs text-muted">Loading changes…</p>;
  if (error) return <ErrorNote error={error} />;
  if (changed.length === 0) return <p className="text-xs text-muted">No changes since the indexed version.</p>;
  return (
    <ul aria-label="Changed blocks" className="flex flex-col gap-1.5">
      {changed.map((e) => (
        <Entry key={`${e.blockId}-${e.change}`} entry={e} selfId={selfId} />
      ))}
    </ul>
  );
}
