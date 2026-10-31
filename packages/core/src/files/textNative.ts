import type { ExtractedDocument, ExtractedSection } from '@kinote/contracts';

const decode = (bytes: Uint8Array): string =>
  new TextDecoder('utf-8').decode(bytes).replace(/^﻿/, '');

const section = (headingPath: string[], text: string, kind: 'text' | 'table' = 'text'): ExtractedSection => ({
  headingPath,
  pageFrom: null,
  pageTo: null,
  kind,
  text,
});

/** RFC 4180 records: quoted cells, doubled quotes, line breaks inside quotes; CRLF or LF. */
export function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const endCell = () => {
    row.push(cell);
    cell = '';
  };
  const endRow = () => {
    endCell();
    rows.push(row);
    row = [];
  };
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (quoted) {
      if (ch === '"' && input[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      endCell();
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && input[i + 1] === '\n') i++;
      endRow();
    } else {
      cell += ch;
    }
  }
  if (cell !== '' || row.length > 0) endRow();
  return rows;
}

function readMarkdown(text: string): ExtractedSection[] {
  const sections: ExtractedSection[] = [];
  let stack: Array<{ level: number; text: string }> = [];
  let buffer: string[] = [];
  let fence: string | null = null;

  const flush = () => {
    const body = buffer.join('\n').trim();
    if (body) sections.push(section(stack.map((h) => h.text), body));
    buffer = [];
  };

  for (const line of text.split(/\r?\n/)) {
    const marker = /^\s*(```|~~~)/.exec(line)?.[1];
    if (marker) {
      if (fence === null) fence = marker;
      else if (fence === marker) fence = null;
    }
    const heading = fence === null && !marker ? /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line) : null;
    if (heading) {
      flush();
      const level = heading[1]!.length;
      while (stack.length > 0 && stack[stack.length - 1]!.level >= level) stack.pop();
      stack.push({ level, text: heading[2]! });
    } else {
      buffer.push(line);
    }
  }
  flush();
  return sections;
}

/**
 * Reads a plain-text type without the extractor. TXT is one text section; MD is
 * cut at its headings (not inside code fences); CSV is one table whose rows
 * are the records, one per line, with cells joined by " | ".
 */
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** The visible text of an HTML page: scripts, styles and comments dropped, tags removed, common entities decoded. */
export function htmlToText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<\/?(p|div|br|li|tr|h[1-6]|section|article|header|footer|table|ul|ol|pre|blockquote)\b[^>]*>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === '#') {
        const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export type TextNativeType = 'txt' | 'md' | 'csv' | 'json' | 'yaml' | 'html' | 'code';

export function readTextNative(type: TextNativeType, bytes: Uint8Array): ExtractedDocument {
  const text = decode(bytes);
  let sections: ExtractedSection[];
  if (type === 'html') {
    const visible = htmlToText(text);
    sections = visible ? [section([], visible)] : [];
  } else if (type === 'txt' || type === 'json' || type === 'yaml' || type === 'code') {
    sections = text.trim() ? [section([], text.trim())] : [];
  } else if (type === 'md') {
    sections = readMarkdown(text);
  } else {
    const rows = parseCsv(text).filter((r) => r.some((c) => c.trim() !== ''));
    // A table's rows are told apart by line breaks, so a line break inside a cell reads as a space.
    const flat = (cell: string) => cell.replace(/\s*[\r\n]+\s*/g, ' ');
    sections = rows.length > 0 ? [section([], rows.map((r) => r.map(flat).join(' | ')).join('\n'), 'table')] : [];
  }
  return { pageCount: null, sections, ocrUsed: false };
}
