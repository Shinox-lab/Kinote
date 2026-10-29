import { createHash } from 'node:crypto';
import type { ExtractedSection } from '@kinote/contracts';
import { DEFAULT_CHUNK_OPTIONS, type ChunkOptions, type RawChunk } from '../indexing/chunkPage.js';

const countWords = (s: string) => s.split(/\s+/).filter(Boolean).length;

/** Packs words into pieces of at most `limit` words. */
function splitWords(text: string, limit: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < words.length; i += limit) out.push(words.slice(i, i + limit).join(' '));
  return out;
}

/** A paragraph above `maxWords` becomes pieces of about `targetWords`: whole sentences first, words when a sentence alone is too long. */
function splitParagraph(paragraph: string, opts: ChunkOptions): string[] {
  if (countWords(paragraph) <= opts.maxWords) return [paragraph];
  const pieces: string[] = [];
  let current: string[] = [];
  let words = 0;
  const flush = () => {
    if (current.length > 0) pieces.push(current.join(' '));
    current = [];
    words = 0;
  };
  for (const sentence of paragraph.split(/(?<=[.!?])\s+/)) {
    const n = countWords(sentence);
    if (n > opts.targetWords) {
      flush();
      pieces.push(...splitWords(sentence, opts.targetWords));
    } else {
      if (words + n > opts.targetWords) flush();
      current.push(sentence);
      words += n;
    }
  }
  flush();
  return pieces;
}

/**
 * A table is one unit; over `maxWords` it splits on lines and each part starts with the header
 * line, also the pieces of a single row that is itself too long.
 */
function splitTable(text: string, opts: ChunkOptions): string[] {
  if (countWords(text) <= opts.maxWords) return [text];
  const [header = '', ...rows] = text.split('\n');
  const headerWords = countWords(header);
  const parts: string[] = [];
  let current: string[] = [];
  let words = headerWords;
  const flush = () => {
    if (current.length > 0) parts.push([header, ...current].join('\n'));
    current = [];
    words = headerWords;
  };
  for (const row of rows) {
    const n = countWords(row);
    if (n > opts.targetWords) {
      flush();
      const room = Math.max(1, opts.targetWords - headerWords);
      parts.push(...splitWords(row, room).map((piece) => `${header}\n${piece}`));
      continue;
    }
    if (words + n > opts.targetWords) flush();
    current.push(row);
    words += n;
  }
  flush();
  return parts;
}

interface Unit {
  headingPath: string[];
  text: string;
  words: number;
  table: boolean;
  pageFrom: number | null;
  pageTo: number | null;
}

interface Draft {
  headingPath: string[];
  texts: string[];
  words: number;
  table: boolean;
  pageFrom: number | null;
  pageTo: number | null;
}

const minOf = (a: number | null, b: number | null) => (a === null ? b : b === null ? a : Math.min(a, b));
const maxOf = (a: number | null, b: number | null) => (a === null ? b : b === null ? a : Math.max(a, b));
const samePath = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Splits extracted text into chunks. A new chunk starts when the heading path
 * or the page changes (a citation names one page); paragraphs under one heading
 * on one page fill a chunk up to `targetWords`; a
 * table is never mixed with prose and stays whole unless over `maxWords`, when
 * it splits by rows with its header line repeated. Every chunk's text starts
 * with the title and heading path (Rule 8), carries the pages it spans and has
 * no block ids (those belong to pages).
 */
export function chunkExtracted(
  title: string,
  sections: ExtractedSection[],
  opts: ChunkOptions = DEFAULT_CHUNK_OPTIONS
): RawChunk[] {
  const units: Unit[] = [];
  for (const s of sections) {
    const body = s.text.trim();
    if (!body) continue;
    const parts =
      s.kind === 'table'
        ? splitTable(body, opts)
        : body.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean).flatMap((p) => splitParagraph(p, opts));
    for (const text of parts) {
      units.push({
        headingPath: s.headingPath,
        text,
        words: countWords(text),
        table: s.kind === 'table',
        pageFrom: s.pageFrom,
        pageTo: s.pageTo ?? s.pageFrom,
      });
    }
  }

  const drafts: Draft[] = [];
  let current: Draft | null = null;
  for (const u of units) {
    // Pages are what a citation points at, so text from another page never joins a chunk.
    const joins =
      current !== null &&
      !u.table &&
      !current.table &&
      samePath(current.headingPath, u.headingPath) &&
      current.pageFrom === u.pageFrom &&
      current.pageTo === u.pageTo &&
      current.words + u.words <= opts.targetWords;
    if (!joins) {
      current = { headingPath: u.headingPath, texts: [], words: 0, table: u.table, pageFrom: null, pageTo: null };
      drafts.push(current);
    }
    current!.texts.push(u.text);
    current!.words += u.words;
    current!.pageFrom = minOf(current!.pageFrom, u.pageFrom);
    current!.pageTo = maxOf(current!.pageTo, u.pageTo);
  }

  return drafts.map((d, ordinal) => {
    const header = d.headingPath.length > 0 ? `${title} > ${d.headingPath.join(' > ')}` : title;
    const text = `# ${header}\n\n${d.texts.join('\n\n')}`;
    return {
      ordinal,
      headingPath: d.headingPath,
      blockIds: [],
      text,
      tokenCount: countWords(text),
      contentHash: createHash('sha256').update(text, 'utf8').digest('hex'),
      pageFrom: d.pageFrom,
      pageTo: d.pageTo,
    };
  });
}
