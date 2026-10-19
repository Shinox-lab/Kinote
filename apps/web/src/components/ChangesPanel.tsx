import type { BlockDiffEntry } from '@living-wiki/contracts';
import { canAdminister } from '../lib/console.js';
import { useMembers, usePageChanges, useWorkspace } from '../lib/queries.js';
import { loadSession } from '../lib/session.js';
import { authorColor, authorLabel } from '../lib/wiki.js';
import { Card, ErrorNote, Loading } from './ui.js';

const CHANGE_WORD = { added: 'Added', changed: 'Changed', removed: 'Removed' } as const;

/** A diff entry that is not `unchanged`. */
type Change = BlockDiffEntry & { change: keyof typeof CHANGE_WORD };

function Entry({ entry, names, selfId }: { entry: Change; names: Map<string, string>; selfId: string | null }) {
  const color = entry.author ? authorColor(entry.author.id) : null;
  const who = entry.author ? authorLabel(entry.author, names, selfId) : null;
  return (
    <li
      className="rounded-md border-l-4 px-3 py-2 text-sm"
      style={color ? { borderLeftColor: color.accent, backgroundColor: color.tint } : { borderLeftColor: '#94a3b8', backgroundColor: '#f1f5f9' }}
    >
      <p className="mb-1 flex flex-wrap items-center gap-x-2 text-xs font-medium text-slate-800">
        <span>{CHANGE_WORD[entry.change]}</span>
        {who && (
          <>
            <span aria-hidden="true">·</span>
            <span aria-hidden="true" className="size-2 rounded-full" style={{ backgroundColor: color?.accent }} />
            <span>{who.name}</span>
            {who.isAgent && <span className="rounded bg-slate-800 px-1.5 text-[10px] uppercase tracking-wide text-white">Agent</span>}
          </>
        )}
      </p>
      {entry.change === 'changed' && entry.before !== undefined && (
        <p className="text-slate-500 line-through">{entry.before || '(empty block)'}</p>
      )}
      <p className="whitespace-pre-wrap break-words text-slate-900">
        {(entry.change === 'removed' ? entry.before : entry.after) || '(empty block)'}
      </p>
    </li>
  );
}

/** What changed since the indexed version, each block washed in its author's colour and labelled with their name. */
export function ChangesPanel({ pageId }: { pageId: string }) {
  const { role } = useWorkspace();
  const { data: entries, error, isPending } = usePageChanges(pageId);
  // Only workspace admins may list members; everyone else sees a short id tag next to "Collaborator".
  const { data: members = [] } = useMembers(canAdminister(role));
  const names = new Map(members.map((m) => [m.userId, m.name]));
  const selfId = loadSession()?.user.id ?? null;

  const changed = (entries ?? []).filter((e): e is Change => e.change !== 'unchanged');

  return (
    <Card title="Changes">
      {isPending ? (
        <Loading what="changes" />
      ) : error ? (
        <ErrorNote error={error} />
      ) : changed.length === 0 ? (
        <p className="text-sm text-slate-600">No changes since the indexed version.</p>
      ) : (
        <ul aria-label="Changed blocks" className="flex flex-col gap-2">
          {changed.map((e) => (
            <Entry key={`${e.blockId}-${e.change}`} entry={e} names={names} selfId={selfId} />
          ))}
        </ul>
      )}
    </Card>
  );
}
