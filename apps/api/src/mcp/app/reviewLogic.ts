/**
 * The review panel's state, without the DOM (tested on its own). The panel (`reviewPanel.ts`) renders these
 * cards and calls `kinote_review_list` / `kinote_review_decide` through the host.
 */
import type { ReviewPanelItem } from '../review/items.js';

export type { ReviewPanelItem };
export type ReviewList = { items: ReviewPanelItem[]; can_decide_here: boolean; reviews_url?: string };
export type DecideReply = { ok: boolean; status?: string; message?: string };
export type Decision = 'approve' | 'reject';
export interface CardState {
  item: ReviewPanelItem;
  outcome: null | { kind: 'done' | 'error'; text: string };
  busy: boolean;
}
export type DiffLine = { op: 'same' | 'del' | 'ins'; text: string };

export const EMPTY = 'Nothing is waiting for you.';
/** Past this many line pairs the diff is not computed: everything before is removed, everything after added. */
const MAX_DIFF_CELLS = 1_000_000;

export function cardsFrom(list: ReviewList): { cards: CardState[]; canDecide: boolean; empty: string | null } {
  return {
    cards: list.items.map((item) => ({ item, outcome: null, busy: false })),
    canDecide: list.can_decide_here,
    empty: list.items.length === 0 ? EMPTY : null,
  };
}

const KIND: Record<ReviewPanelItem['kind'], string> = {
  version: 'New version',
  remove: 'Remove a block',
  replace: 'Replace a block',
  insert: 'Add a block',
  set_field: 'Change a field',
  archive: 'Delete this page',
};

export function kindLabel(item: ReviewPanelItem): string {
  return item.file ? `New version of ${item.file.name}` : KIND[item.kind];
}

/** A size as the panel shows it: B, KB or MB. */
function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** A file item's versions and sizes: `v1 · 47 KB → v2 · 48 KB`, or `v2 · 48 KB` for a first version. */
export function fileSummary(item: ReviewPanelItem): string {
  const f = item.file;
  if (!f) return '';
  const after = `v${f.after.version} · ${size(f.after.size)}`;
  return f.before ? `v${f.before.version} · ${size(f.before.size)} → ${after}` : after;
}

const linesOf = (text: string) => (text === '' ? [] : text.split('\n'));

/** A line diff (longest common subsequence) of two Markdown texts. */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = linesOf(before);
  const b = linesOf(after);
  if (a.length * b.length > MAX_DIFF_CELLS) {
    return [...a.map((text) => ({ op: 'del' as const, text })), ...b.map((text) => ({ op: 'ins' as const, text }))];
  }
  // lcs[i][j]: the common length of a[i..] and b[j..].
  const lcs = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ op: 'same', text: a[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      out.push({ op: 'del', text: a[i++]! });
    } else {
      out.push({ op: 'ins', text: b[j++]! });
    }
  }
  while (i < a.length) out.push({ op: 'del', text: a[i++]! });
  while (j < b.length) out.push({ op: 'ins', text: b[j++]! });
  return out;
}

export function applyOutcome(card: CardState, reply: DecideReply, decision: Decision): CardState {
  const outcome = reply.ok
    ? { kind: 'done' as const, text: decision === 'approve' ? 'Approved' : 'Rejected' }
    : { kind: 'error' as const, text: reply.message ?? 'Kinote could not do that.' };
  return { ...card, outcome, busy: false };
}

/** What the panel tells the model after a decision. */
export function contextLine(item: ReviewPanelItem, decision: Decision): string {
  return `${decision === 'approve' ? 'Approved' : 'Rejected'}: ${item.kind} on "${item.page.title}".`;
}

/** "3 minutes ago"-style age of an ISO time, against `now`. */
export function age(iso: string, now: Date = new Date()): string {
  const s = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.round(h / 24);
  return `${d} days ago`;
}
