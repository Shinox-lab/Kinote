import type { ExtractedSection } from '@living-wiki/contracts';

// Words for the chunk inspector and the review queue's text preview. Text only: nothing here is markup.

/** The non-empty lines of the extracted text, in order, up to `maxLines`; `truncated` says there was more. */
export function previewLines(sections: readonly ExtractedSection[], maxLines = 40): { lines: string[]; truncated: boolean } {
  const lines: string[] = [];
  for (const section of sections) {
    for (const raw of section.text.split(/\r?\n/)) {
      const line = raw.trim();
      if (line === '') continue;
      if (lines.length === maxLines) return { lines, truncated: true };
      lines.push(line);
    }
  }
  return { lines, truncated: false };
}

const wordCount = (text: string): number => text.split(/\s+/).filter(Boolean).length;

/** "Pages 2–3 · 142 words", "Page 4 · 60 words", or "142 words" when the chunk has no page. */
export function chunkSummary(chunk: { pageFrom: number | null; pageTo: number | null; text: string }): string {
  const n = wordCount(chunk.text);
  const size = `${n} ${n === 1 ? 'word' : 'words'}`;
  if (chunk.pageFrom === null) return size;
  const to = chunk.pageTo ?? chunk.pageFrom;
  return to > chunk.pageFrom ? `Pages ${chunk.pageFrom}–${to} · ${size}` : `Page ${chunk.pageFrom} · ${size}`;
}
