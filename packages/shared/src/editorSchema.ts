import { BlockNoteSchema, createInlineContentSpec, defaultInlineContentSpecs } from '@blocknote/core';
import { ServerBlockNoteEditor } from '@blocknote/server-util';
import { PAGE_LINK_PATH, pageLinkConfig, pageLinkPath } from '@living-wiki/contracts';
import type { BlockLike } from './blocks.js';

/**
 * The server side of a page link: rendered as a link to the page, so
 * Markdown and HTML conversions keep the title and the target.
 */
const pageLink = createInlineContentSpec(pageLinkConfig, {
  render: (inline) => {
    const a = document.createElement('a');
    a.href = pageLinkPath(inline.props.documentId);
    a.textContent = inline.props.title || 'Untitled';
    return { dom: a };
  },
});

/** The wiki's block schema: BlockNote's defaults plus page links. */
export const wikiSchema = BlockNoteSchema.create({
  inlineContentSpecs: { ...defaultInlineContentSpecs, pageLink },
});

/**
 * A server-side editor on the wiki's schema. Every server conversion must use
 * it: an editor on the default schema silently drops page links.
 */
export function createServerEditor() {
  return ServerBlockNoteEditor.create({ schema: wikiSchema });
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Inline arrays of a block: its content, or each table cell's. */
function inlineArrays(content: unknown): unknown[][] {
  if (Array.isArray(content)) return [content];
  if (!isRecord(content) || content.type !== 'tableContent' || !Array.isArray(content.rows)) return [];
  const out: unknown[][] = [];
  for (const row of content.rows) {
    if (!isRecord(row) || !Array.isArray(row.cells)) continue;
    for (const cell of row.cells) {
      if (Array.isArray(cell)) out.push(cell);
      else if (isRecord(cell) && Array.isArray(cell.content)) out.push(cell.content);
    }
  }
  return out;
}

/** The page links of blocks (children included), one per (block, target), ids lower-cased. */
export function pageLinksOf(blocks: BlockLike[]): Array<{ blockId: string; targetId: string }> {
  const seen = new Set<string>();
  const out: Array<{ blockId: string; targetId: string }> = [];
  const walk = (list: BlockLike[]) => {
    for (const b of list) {
      for (const inline of inlineArrays(b.content)) {
        for (const item of inline) {
          if (!isRecord(item) || item.type !== pageLinkConfig.type || !isRecord(item.props)) continue;
          const targetId = String(item.props.documentId ?? '').toLowerCase();
          if (!UUID.test(targetId)) continue;
          const key = `${b.id}\u0000${targetId}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({ blockId: b.id, targetId });
        }
      }
      if (Array.isArray(b.children)) walk(b.children);
    }
  };
  walk(blocks);
  return out;
}

function linkText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content.map((c) => (isRecord(c) && typeof c.text === 'string' ? c.text : '')).join('');
}

/**
 * Blocks parsed from Markdown with their `/p/<id>` links turned back into
 * page links: how a page link survives the router's Markdown round trip.
 */
export function restorePageLinks<T extends BlockLike>(blocks: T[]): T[] {
  const fix = (inline: unknown[]) =>
    inline.map((item) => {
      if (!isRecord(item) || item.type !== 'link' || typeof item.href !== 'string') return item;
      const match = PAGE_LINK_PATH.exec(item.href);
      if (!match) return item;
      return { type: pageLinkConfig.type, props: { documentId: match[1]!.toLowerCase(), title: linkText(item.content) } };
    });
  const fixContent = (content: unknown): unknown => {
    if (Array.isArray(content)) return fix(content);
    if (!isRecord(content) || content.type !== 'tableContent' || !Array.isArray(content.rows)) return content;
    return {
      ...content,
      rows: content.rows.map((row) =>
        isRecord(row) && Array.isArray(row.cells)
          ? {
              ...row,
              cells: row.cells.map((cell) =>
                Array.isArray(cell) ? fix(cell) : isRecord(cell) && Array.isArray(cell.content) ? { ...cell, content: fix(cell.content) } : cell
              ),
            }
          : row
      ),
    };
  };
  return blocks.map(
    (b) =>
      ({
        ...b,
        content: fixContent(b.content),
        ...(Array.isArray(b.children) ? { children: restorePageLinks(b.children) } : {}),
      }) as T
  );
}
