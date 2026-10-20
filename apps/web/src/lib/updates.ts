import type { UpdateItem } from '@living-wiki/contracts';

// Wording for the sidebar's Updates feed. The server decides what happened
// (the status); this only turns it into a short sentence.

/** "Aisha published v2 of Leave policy": the actor and the rest of the sentence, kept apart so the actor can be styled. */
export function updateSentence(item: UpdateItem, selfId: string | null): { who: string; what: string } {
  const isSelf = item.actor.type === 'user' && selfId !== null && item.actor.id === selfId;
  const who = isSelf ? 'You' : item.actor.name;
  const { title } = item.document;
  const v = `v${item.number}`;
  if (item.document.kind === 'file') return { who, what: fileWhat(item, title, v) };
  switch (item.status) {
    case 'pending_review':
      return { who, what: `proposed a change to ${title}` };
    case 'indexed':
      return { who, what: `published ${v} of ${title}` };
    // Rejected, withdrawn and failed are things that happened TO the author's version, not by them.
    case 'rejected':
      return { who, what: `had ${v} of ${title} rejected` };
    case 'withdrawn':
      return { who, what: `had ${v} of ${title} withdrawn` };
    case 'failed':
      return { who, what: `had ${v} of ${title} fail to index` };
  }
}

/** What happened to a file: the first version is an upload, a later one a replacement, a connector's a sync. */
function fileWhat(item: UpdateItem, title: string, v: string): string {
  switch (item.status) {
    case 'rejected':
      return `had ${v} of ${title} rejected`;
    case 'withdrawn':
      return `had ${v} of ${title} withdrawn`;
    case 'failed':
      return `had ${v} of ${title} fail to index`;
    default:
      if (item.actor.type === 'system') return `synced ${title}`;
      return item.number <= 1 ? `uploaded ${title}` : `replaced ${title}`;
  }
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "just now", "4m", "3h", "2d", then a short date; empty for a time that cannot be read. */
export function relativeTime(iso: string, now: Date, locale = 'en-US', timeZone?: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const age = now.getTime() - then;
  if (age < MINUTE) return 'just now';
  if (age < HOUR) return `${Math.floor(age / MINUTE)}m`;
  if (age < DAY) return `${Math.floor(age / HOUR)}h`;
  if (age < 7 * DAY) return `${Math.floor(age / DAY)}d`;
  return new Date(then).toLocaleDateString(locale, { month: 'short', day: 'numeric', timeZone });
}
