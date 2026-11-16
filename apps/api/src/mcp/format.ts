import { estimateTokens } from '@kinote/core';
import type { AgentAuth } from '../auth/actor.js';

/** The most a tool result may use, measured with `estimateTokens`. */
export const MAX_RESULT_TOKENS = 6000;

const CUT_NOTE = '[Result cut at 6,000 tokens.]';

/** How results name a page: the first 8 hex characters of its id. */
export function shortId(uuid: string): string {
  return uuid.replaceAll('-', '').slice(0, 8).toLowerCase();
}

/** A link to the page (or file) in the console when PUBLIC_URL is set; null without it. */
export function pageLink(
  agent: Pick<AgentAuth, 'tenantSlug'>,
  publicUrl: string | undefined,
  pageId: string,
  kind: 'page' | 'file' = 'page'
): string | null {
  if (!publicUrl) return null;
  const base = publicUrl.replace(/\/+$/, '');
  return `${base}/w/${encodeURIComponent(agent.tenantSlug)}/${kind === 'file' ? 'f' : 'p'}/${pageId}`;
}

const escapeContent = (text: string) => text.replace(/<\/(kinote:content)/gi, '<\\/$1');

/**
 * Page content as data: Markdown inside `<kinote:content page="…">`. A closing tag written in the page is
 * escaped (`<\/kinote:content`) so the content can never end the block early.
 */
export function contentBlock(pageShortId: string, markdown: string): string {
  return `<kinote:content page="${pageShortId}">\n${escapeContent(markdown)}\n</kinote:content>`;
}

/**
 * Wiki-written text that is not one page's body (a map of titles and summaries, a list of results, an answer
 * written from pages): inside `<kinote:content source="…">`, escaped the same way.
 */
export function dataBlock(source: 'map' | 'results' | 'answer' | 'receipt' | 'preview', text: string): string {
  return `<kinote:content source="${source}">\n${escapeContent(text)}\n</kinote:content>`;
}

/**
 * The last-resort cap on any tool result: unchanged when it fits in MAX_RESULT_TOKENS, else cut at the last
 * whole line that fits, followed by a note. Tools that page their own output stop earlier with a cursor.
 */
export function capResult(text: string): string {
  if (estimateTokens(text) <= MAX_RESULT_TOKENS) return text;
  const room = MAX_RESULT_TOKENS * 4 - (CUT_NOTE.length + 1);
  const head = text.slice(0, room);
  const lastBreak = head.lastIndexOf('\n');
  const kept = lastBreak > 0 ? head.slice(0, lastBreak) : head;
  return `${kept}\n${CUT_NOTE}`;
}

/** An opaque continuation token: base64url JSON. */
export function encodeCursor(obj: object): string {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
}

/** The object behind a cursor, or null when the string is not one this server made. */
export function decodeCursor<T>(raw: string): T | null {
  if (!/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  try {
    const value: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as T) : null;
  } catch {
    return null;
  }
}
