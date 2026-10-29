import { BlockNoteSchema, createBlockSpec, createExtension, createInlineContentSpec, defaultBlockSpecs, defaultInlineContentSpecs } from '@blocknote/core';
import { CommentMark } from '@blocknote/core/comments';
import { ServerBlockNoteEditor } from '@blocknote/server-util';
import { MENTION_PATH, PAGE_LINK_PATH, calloutConfig, collectionViewConfig, fileEmbedConfig, mentionConfig, mentionPath, pageLinkConfig, pageLinkPath } from '@living-wiki/contracts';
import type { BlockLike } from './blocks.js';

/**
 * A page link's text in Markdown: Markdown punctuation is escaped, so a title
 * like `a]b` or `x](y)` can't end the link early and lose it.
 */
function linkLabel(title: string): string {
  return title.replace(/[\\`*_[\]<>]/g, (c) => `\\${c}`);
}

/**
 * The server side of a page link: rendered as a link to the page, so
 * Markdown and HTML conversions keep the title and the target.
 */
const pageLink = createInlineContentSpec(pageLinkConfig, {
  render: (inline) => {
    const a = document.createElement('a');
    a.href = pageLinkPath(inline.props.documentId);
    a.textContent = linkLabel(inline.props.title || 'Untitled');
    return { dom: a };
  },
});

/** The server side of a mention: a link to the person, so Markdown keeps who it is. */
const mention = createInlineContentSpec(mentionConfig, {
  render: (inline) => {
    const a = document.createElement('a');
    a.href = mentionPath(inline.props.userId);
    a.textContent = linkLabel(`@${inline.props.name || 'Someone'}`);
    return { dom: a };
  },
});

/** A pasted file renders as a link to its file document on the server (Yjs snapshots, Markdown). */
const fileEmbed = createBlockSpec(fileEmbedConfig, {
  render: (block) => {
    const a = document.createElement('a');
    a.href = pageLinkPath(block.props.documentId);
    a.textContent = block.props.error || block.props.name || 'File';
    return { dom: a };
  },
})();

/** A callout on the server: its emoji, then its text (Markdown reads it as one paragraph). */
const callout = createBlockSpec(calloutConfig, {
  render: (block) => {
    const dom = document.createElement('p');
    const emoji = document.createElement('span');
    emoji.textContent = `${block.props.emoji} `;
    const contentDOM = document.createElement('span');
    dom.append(emoji, contentDOM);
    return { dom, contentDOM };
  },
})();

/** A collection view on the server: one line naming its collection, linked to it (its rows live on their own pages). */
const collectionView = createBlockSpec(collectionViewConfig, {
  render: (block) => {
    const dom = document.createElement('p');
    dom.append('Collection view: ');
    const a = document.createElement('a');
    a.href = pageLinkPath(block.props.collectionId);
    a.textContent = linkLabel(block.props.title || 'Untitled');
    dom.append(a);
    return { dom };
  },
})();

/** The wiki's block schema: BlockNote's defaults plus page links and mentions. */
export const wikiSchema = BlockNoteSchema.create({
  blockSpecs: { ...defaultBlockSpecs, fileEmbed, callout, collectionView },
  inlineContentSpecs: { ...defaultInlineContentSpecs, pageLink, mention },
});

/**
 * A server-side editor on the wiki's schema. Every server conversion must use
 * it: an editor on the default schema silently drops page links, and one
 * without the comment mark reads a commented page as empty.
 */
export function createServerEditor() {
  return ServerBlockNoteEditor.create({ schema: wikiSchema, extensions: [commentMarks] });
}

/**
 * The comment mark alone (threads live in the API, not here). Without it a
 * server editor reads a page that has a comment as no blocks at all.
 */
const commentMarks = createExtension({ key: 'commentMarks', tiptapExtensions: [CommentMark] });

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

/** The inline nodes of one type in blocks (children included), once per (block, key), keys lower-cased. */
function inlineNodesOf(
  blocks: BlockLike[],
  type: string,
  keyProp: string
): Array<{ blockId: string; key: string }> {
  const seen = new Set<string>();
  const out: Array<{ blockId: string; key: string }> = [];
  const walk = (list: BlockLike[]) => {
    for (const b of list) {
      for (const inline of inlineArrays(b.content)) {
        for (const item of inline) {
          if (!isRecord(item) || item.type !== type || !isRecord(item.props)) continue;
          const key = String(item.props[keyProp] ?? '').toLowerCase();
          if (!UUID.test(key) || seen.has(`${b.id}\u0000${key}`)) continue;
          seen.add(`${b.id}\u0000${key}`);
          out.push({ blockId: b.id, key });
        }
      }
      if (Array.isArray(b.children)) walk(b.children);
    }
  };
  walk(blocks);
  return out;
}

/** The page links of blocks (children included), one per (block, target), ids lower-cased. */
export function pageLinksOf(blocks: BlockLike[]): Array<{ blockId: string; targetId: string }> {
  return inlineNodesOf(blocks, pageLinkConfig.type, 'documentId').map((n) => ({ blockId: n.blockId, targetId: n.key }));
}

/** Who is mentioned in which block (children included), once per (block, person), ids lower-cased. */
export function mentionsOf(blocks: BlockLike[]): Array<{ blockId: string; userId: string }> {
  return inlineNodesOf(blocks, mentionConfig.type, 'userId').map((n) => ({ blockId: n.blockId, userId: n.key }));
}

function linkText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content.map((c) => (isRecord(c) && typeof c.text === 'string' ? c.text : '')).join('');
}

/**
 * Blocks parsed from Markdown with their `/p/<id>` links turned back into
 * page links and `/u/<id>` links into mentions: how both survive the router's
 * Markdown round trip.
 */
export function restorePageLinks<T extends BlockLike>(blocks: T[]): T[] {
  const fix = (inline: unknown[]) =>
    inline.map((item) => {
      if (!isRecord(item) || item.type !== 'link' || typeof item.href !== 'string') return item;
      const page = PAGE_LINK_PATH.exec(item.href);
      if (page) return { type: pageLinkConfig.type, props: { documentId: page[1]!.toLowerCase(), title: linkText(item.content) } };
      const person = MENTION_PATH.exec(item.href);
      if (person) {
        return { type: mentionConfig.type, props: { userId: person[1]!.toLowerCase(), name: linkText(item.content).replace(/^@/, '') } };
      }
      return item;
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
