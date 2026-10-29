import { createHash } from 'node:crypto';
import { flattenBlocks, type BlockLike } from '@kinote/shared';

export interface ChunkOptions {
  /** A section keeps growing between blocks while it stays within this many words. */
  targetWords: number;
  /** A single block above this is never combined with other blocks. */
  maxWords: number;
}

export const DEFAULT_CHUNK_OPTIONS: ChunkOptions = { targetWords: 350, maxWords: 600 };

export interface RawChunk {
  ordinal: number;
  headingPath: string[];
  blockIds: string[];
  text: string;
  tokenCount: number;
  contentHash: string;
  /** Pages the chunk spans: set for file chunks only (a page's chunks do not carry them). */
  pageFrom?: number | null;
  pageTo?: number | null;
}

interface Draft {
  headingPath: string[];
  blockIds: string[];
  texts: string[];
  words: number;
  /** True once a non-heading block is in the chunk. */
  hasBody: boolean;
  /** Level of the last heading in the chunk (0 when it has none). */
  lastLevel: number;
  /** True when the chunk holds a block above maxWords (which then stays alone). */
  oversized: boolean;
}

const countWords = (s: string) => s.split(/\s+/).filter(Boolean).length;

/**
 * Splits a page's real BlockNote blocks into chunks. Headings start a section
 * and set the heading path; a long section continues in a new chunk between
 * blocks, never inside one. Every chunk's text starts with the document title
 * and heading path. A collection row's field lines (`Status: Active`) go
 * under the title of its first chunk; a row with no text gets one chunk of
 * them alone.
 */
export function chunkPageBlocks(
  title: string,
  blocks: BlockLike[],
  opts: ChunkOptions = DEFAULT_CHUNK_OPTIONS,
  fieldLines: string[] = []
): RawChunk[] {
  const drafts: Draft[] = [];
  // Ancestor stack: each entry is a heading still "open" at the current position.
  let stack: Array<{ level: number; text: string }> = [];
  let current: Draft | null = null;

  const start = (): Draft => {
    const draft: Draft = {
      headingPath: stack.map((h) => h.text),
      blockIds: [],
      texts: [],
      words: 0,
      hasBody: false,
      lastLevel: 0,
      oversized: false,
    };
    drafts.push(draft);
    return draft;
  };

  for (const flat of flattenBlocks(blocks)) {
    const text = flat.text.trim();
    if (!text) continue;
    const words = countWords(text);
    const oversized = words > opts.maxWords;

    if (flat.type === 'heading') {
      const level = flat.level ?? 1;
      // Pop every heading at the same or a deeper level (they are closed), then push.
      while (stack.length > 0 && stack[stack.length - 1].level >= level) stack.pop();
      stack.push({ level, text });
      if (current && !current.hasBody && level > current.lastLevel) {
        // A bare heading (no body yet) directly followed by a deeper heading is not
        // emitted on its own: its text and block id travel in the next chunk, whose
        // path is that of the deeper heading. Keeps "no chunk has an empty body".
        current.headingPath = stack.map((h) => h.text);
      } else {
        current = start();
      }
      current.lastLevel = level;
    } else if (
      !current ||
      (current.blockIds.length > 0 &&
        (current.hasBody
          ? oversized || current.oversized || current.words + words > opts.targetWords
          : current.oversized))
    ) {
      // A heading-only chunk never gets left behind just because the next block is
      // large: the heading travels with it (an oversized block still stays alone
      // from other body blocks, because later blocks start a new chunk).
      current = start();
    }

    current.blockIds.push(flat.id);
    current.texts.push(text);
    current.words += words;
    if (flat.type !== 'heading') current.hasBody = true;
    if (oversized) current.oversized = true;
  }

  const kept = drafts.filter((d) => d.blockIds.length > 0);
  if (kept.length === 0 && fieldLines.length > 0) {
    kept.push({ headingPath: [], blockIds: [], texts: [], words: 0, hasBody: false, lastLevel: 0, oversized: false });
  }
  const fieldsPart = fieldLines.length > 0 ? fieldLines.join('\n') : null;
  return kept
    .map((d, ordinal) => {
      const header = d.headingPath.length > 0 ? `${title} > ${d.headingPath.join(' > ')}` : title;
      const parts = [ordinal === 0 ? fieldsPart : null, d.texts.length > 0 ? d.texts.join('\n\n') : null].filter(
        (p): p is string => p !== null
      );
      const text = `# ${header}\n\n${parts.join('\n\n')}`;
      return {
        ordinal,
        headingPath: d.headingPath,
        blockIds: d.blockIds,
        text,
        tokenCount: countWords(text),
        contentHash: createHash('sha256').update(text, 'utf8').digest('hex'),
      };
    });
}
