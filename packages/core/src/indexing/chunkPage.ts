import { createHash } from 'node:crypto';
import { flattenBlocks, type BlockLike } from '@living-wiki/shared';

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
}

interface Draft {
  headingPath: string[];
  blockIds: string[];
  texts: string[];
  words: number;
  /** True once a non-heading block is in the chunk. */
  hasBody: boolean;
  /** True when the chunk holds a block above maxWords (which then stays alone). */
  oversized: boolean;
}

const countWords = (s: string) => s.split(/\s+/).filter(Boolean).length;

/**
 * Splits a page's real BlockNote blocks into chunks. Headings start a section
 * and set the heading path; a long section continues in a new chunk between
 * blocks, never inside one. Every chunk's text starts with the document title
 * and heading path.
 */
export function chunkPageBlocks(
  title: string,
  blocks: BlockLike[],
  opts: ChunkOptions = DEFAULT_CHUNK_OPTIONS
): RawChunk[] {
  const drafts: Draft[] = [];
  let stack: string[] = [];
  let current: Draft | null = null;

  const start = (): Draft => {
    const draft: Draft = {
      headingPath: [...stack],
      blockIds: [],
      texts: [],
      words: 0,
      hasBody: false,
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
      stack = stack.slice(0, Math.max(0, level - 1));
      stack.push(text);
      current = start();
    } else if (
      !current ||
      (current.blockIds.length > 0 &&
        (oversized ||
          current.oversized ||
          (current.hasBody && current.words + words > opts.targetWords)))
    ) {
      current = start();
    }

    current.blockIds.push(flat.id);
    current.texts.push(text);
    current.words += words;
    if (flat.type !== 'heading') current.hasBody = true;
    if (oversized) current.oversized = true;
  }

  return drafts
    .filter((d) => d.blockIds.length > 0)
    .map((d, ordinal) => {
      const header = d.headingPath.length > 0 ? `${title} > ${d.headingPath.join(' > ')}` : title;
      const text = `# ${header}\n\n${d.texts.join('\n\n')}`;
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
