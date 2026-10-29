import type {
  CaptureChange,
  CaptureReceipt,
  CaptureSummary,
  ReviewItem,
  SuggestionSummary,
  UndoChangesResponse,
} from '@kinote/contracts';
import { cssString } from './wiki.js';

// Pure helpers behind the Capture page, the capture highlight on a page and review bundles.
// What happened to a capture is the server's (the receipt); these only word and style it.

export type { CaptureChange };

/** The API's limit for a capture's text (MAX_CAPTURE_CHARS). */
export const CAPTURE_MAX = 20_000;

/** Some capture is still waiting to be routed or being routed: worth polling. */
export function capturesBusy(list: Array<Pick<CaptureSummary, 'status'>> | undefined): boolean {
  return (list ?? []).some((c) => c.status === 'queued' || c.status === 'routing');
}

const STATUS: Record<CaptureSummary['status'], string> = {
  queued: 'Waiting to route',
  routing: 'Routing…',
  waiting_for_answer: 'Needs your answer',
  done: 'Done',
  failed: 'Routing failed',
};

export function captureStatusLabel(status: CaptureSummary['status']): string {
  return STATUS[status];
}

const OUTCOME = {
  applied: 'Applied',
  waiting_review: 'Waiting for review',
  suggestion: 'Suggestion',
  filed_in_document: 'On the new page',
} as const;

export function outcomeLabel(outcome: keyof typeof OUTCOME): string {
  return OUTCOME[outcome];
}

/** The Capture box's "File as" choices: the engine decides, always a new page, or never one. */
export const SHAPE_OPTIONS = [
  { value: 'auto', label: 'Auto' },
  { value: 'document', label: 'New page' },
  { value: 'updates', label: 'Updates only' },
] as const;

/** The receipt's lead for a document capture: where its page went, or that it waits for a place. */
export function documentHeadline(d: NonNullable<CaptureReceipt['document']>): string {
  if (d.outcome === 'needs_home') return `Where should “${d.title}” go?`;
  if (d.outcome === 'pending') return `Creating ${d.title}…`;
  return d.parentTitle ? `New page: ${d.title} under ${d.parentTitle}` : `New page: ${d.title} in ${d.spaceName ?? ''}`;
}

/** Facts of a document kept only on its new page; null when there are none. */
export function keptText(n: number): string | null {
  if (n <= 0) return null;
  return n === 1 ? '1 fact kept on the new page' : `${n} facts kept on the new page`;
}

/** Changes on pages the viewer cannot read, counted and never shown; null when there are none. */
export function hiddenChangesText(n: number): string | null {
  if (n <= 0) return null;
  return n === 1 ? "1 change in a space you can't see" : `${n} changes in spaces you can't see`;
}

const changes = (n: number) => `${n} change${n === 1 ? '' : 's'}`;

/** What an Undo did, including the blocks someone changed since (left alone). */
export function undoNotice(result: UndoChangesResponse): string {
  const parts: string[] = [];
  if (result.undone.length > 0) parts.push(`Undid ${changes(result.undone.length)}.`);
  if (result.changedSince.length > 0) parts.push(`${result.changedSince.length} changed since, not undone.`);
  return parts.length > 0 ? parts.join(' ') : 'Nothing to undo.';
}

/**
 * The capture's applied blocks in the Routing engine's colour (`--routing`),
 * shaped like `blockHighlightCss`. Undone and moved changes are not on the
 * page as the engine wrote them, so they are not tinted.
 */
export function captureHighlightCss(list: readonly CaptureChange[]): string {
  return list
    .filter((c) => c.status === 'applied')
    .map(
      (c) =>
        `[data-id="${cssString(c.blockId)}"] > .bn-block > .bn-block-content ` +
        '{ box-shadow: inset 3px 0 0 var(--routing); background: var(--routing-tint); border-radius: 3px; padding-left: 8px; }'
    )
    .join('\n');
}

/** A dashed margin marker on every block an open suggestion is about. */
export function suggestionMarkerCss(list: readonly SuggestionSummary[]): string {
  return list
    .filter((s) => s.status === 'open' && s.blockId !== null)
    .map(
      (s) =>
        `[data-id="${cssString(s.blockId!)}"] > .bn-block > .bn-block-content ` +
        '{ outline: 1px dashed var(--routing); outline-offset: 2px; border-radius: 3px; }'
    )
    .join('\n');
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuidOrNothing = (value: unknown): string | undefined =>
  typeof value === 'string' && UUID.test(value) ? value : undefined;

/** The Capture page's presets: `?space=` and `?page=` (uuids only). */
export function parseCaptureSearch(search: Record<string, unknown>): { space?: string; page?: string } {
  const space = uuidOrNothing(search.space);
  const page = uuidOrNothing(search.page);
  return { ...(space ? { space } : {}), ...(page ? { page } : {}) };
}

/** A page's "changes from this capture" mode: `?capture=` (a uuid only). */
export function parsePageCaptureSearch(search: Record<string, unknown>): { capture?: string } {
  const capture = uuidOrNothing(search.capture);
  return capture ? { capture } : {};
}

/** A capture's review items the reviewer may approve, and the ones that need someone else. */
export function approvableInBundle(items: ReviewItem[], captureId: string): { approve: ReviewItem[]; skipped: ReviewItem[] } {
  const bundle = items.filter((i) => i.capture?.id === captureId);
  return { approve: bundle.filter((i) => i.canApprove), skipped: bundle.filter((i) => !i.canApprove) };
}

/** The button that accepts a suggestion: a removal is approved, anything else accepted. */
export function suggestionAction(s: Pick<SuggestionSummary, 'kind'>): 'Approve removal' | 'Accept' {
  return s.kind === 'remove' ? 'Approve removal' : 'Accept';
}

/** What a capture can read from a file: documents, slides, sheets, text and pictures (by extension, as the server checks). */
const CAPTURE_FILE_EXTENSIONS = new Set(['pdf', 'docx', 'pptx', 'xlsx', 'csv', 'txt', 'md', 'markdown', 'png', 'jpg', 'jpeg', 'webp', 'gif']);
const AUDIO_VIDEO = /\.(mp3|wav|m4a|ogg|mp4|mov|webm)$/i;

/** Why a file can't go with a capture, or null when it can. */
export function captureFileProblem(file: { name: string; type: string }): string | null {
  if (/^(audio|video)\//.test(file.type) || AUDIO_VIDEO.test(file.name)) return "Audio and video can't be read yet.";
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  return CAPTURE_FILE_EXTENSIONS.has(ext) ? null : "This kind of file can't be read.";
}

/** A capture still waiting for its file to be read. */
export function captureWaitingOnFile(capture: Pick<CaptureSummary, 'status' | 'file'>): boolean {
  return capture.status === 'queued' && capture.file !== null;
}
