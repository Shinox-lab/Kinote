import type { BlockDiffEntry } from '@kinote/contracts';

// Pure helpers behind DiffView: which blocks to show, their labels and the one-line
// summary. The diff itself (what changed) is always the server's.

export type ChangeKind = 'added' | 'changed' | 'removed';

/** A diff entry that is not `unchanged`. */
export type Change = BlockDiffEntry & { change: ChangeKind };

const LABEL: Record<ChangeKind, string> = { added: 'Added', changed: 'Changed', removed: 'Removed' };

/** Summary order: what was added, then changed, then removed. */
const ORDER: ChangeKind[] = ['added', 'changed', 'removed'];

/** The word for a change, so it never relies on colour alone. */
export function changeLabel(change: ChangeKind): string {
  return LABEL[change];
}

/** The blocks that changed, in diff order. */
export function changedEntries(entries: readonly BlockDiffEntry[]): Change[] {
  return entries.filter((e): e is Change => e.change !== 'unchanged');
}

export function diffCounts(entries: readonly BlockDiffEntry[]): Record<ChangeKind, number> {
  const counts = { added: 0, changed: 0, removed: 0 };
  for (const e of entries) if (e.change !== 'unchanged') counts[e.change] += 1;
  return counts;
}

/** "2 added · 1 changed", or "No block changes". */
export function diffSummary(entries: readonly BlockDiffEntry[]): string {
  const counts = diffCounts(entries);
  const parts = ORDER.filter((kind) => counts[kind] > 0).map((kind) => `${counts[kind]} ${kind}`);
  return parts.length > 0 ? parts.join(' · ') : 'No block changes';
}
