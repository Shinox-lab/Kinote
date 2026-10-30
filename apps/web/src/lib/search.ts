import type { AskCitation } from '@kinote/contracts';

// Pure helpers behind the search screen: mapping an answer's citation markers to
// the returned citations. Everything stays plain text; nothing here builds markup.

export type AnswerSegment = { type: 'text'; text: string } | { type: 'citation'; citation: AskCitation };

/**
 * Splits an answer into text and citations. The API writes a citation into the
 * answer as `[citeAs]`; each marker that matches a returned citation becomes a
 * citation segment, any other bracketed text stays text.
 */
export function answerSegments(answer: string, citations: readonly AskCitation[]): AnswerSegment[] {
  const segments: AnswerSegment[] = [];
  let rest = answer;
  while (rest.length > 0) {
    let next: { at: number; marker: string; citation: AskCitation } | null = null;
    for (const citation of citations) {
      const marker = `[${citation.citeAs}]`;
      const at = rest.indexOf(marker);
      if (at !== -1 && (next === null || at < next.at || (at === next.at && marker.length > next.marker.length))) {
        next = { at, marker, citation };
      }
    }
    if (next === null) {
      segments.push({ type: 'text', text: rest });
      break;
    }
    if (next.at > 0) segments.push({ type: 'text', text: rest.slice(0, next.at) });
    segments.push({ type: 'citation', citation: next.citation });
    rest = rest.slice(next.at + next.marker.length);
  }
  return segments;
}

/**
 * The Search screen's shareable params: the query, one space, and whether an answer was asked for. `ask` lives in the
 * address so leaving the screen and coming back keeps the answer (or the request still running) in view.
 */
export function parseSearchSearch(search: Record<string, unknown>): { q?: string; space?: string; ask?: true } {
  const q = typeof search.q === 'string' && search.q.trim() !== '' ? search.q.slice(0, SEARCH_MAX) : undefined;
  const space = typeof search.space === 'string' && search.space !== '' ? search.space : undefined;
  const ask = q !== undefined && (search.ask === '1' || search.ask === 1 || search.ask === true);
  return { ...(q !== undefined ? { q } : {}), ...(space !== undefined ? { space } : {}), ...(ask ? { ask: true as const } : {}) };
}

/** A passage's heading path as one line; empty when the passage has none. */
export function headingLine(path: readonly string[]): string {
  return path.join(' › ');
}

/** The API's limits (SearchRequestSchema, AskRequestSchema), on the trimmed text. */
const SEARCH_MAX = 500;
const ASK_MAX = 1000;

/** Which of Search and Ask a query may be sent to: not when empty, nor past that action's limit. */
export function queryAllows(query: string): { search: boolean; ask: boolean } {
  const length = query.trim().length;
  return { search: length >= 1 && length <= SEARCH_MAX, ask: length >= 1 && length <= ASK_MAX };
}
