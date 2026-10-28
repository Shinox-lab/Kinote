/**
 * Flattening of real BlockNote blocks (the shape `yDocToBlocks` returns:
 * `{ id, type, props, content: InlineContent[] | TableContent, children }`)
 * into plain text. Typed structurally so this package needs no BlockNote
 * dependency; BlockNote's `Block[]` is assignable to `BlockLike[]`.
 */
export interface BlockLike {
  id: string;
  type: string;
  props?: Record<string, unknown>;
  content?: unknown;
  children?: BlockLike[];
}

export interface FlatBlock {
  id: string;
  type: string;
  /** Heading level (`props.level`), headings only. */
  level?: number;
  /** Plain text of the block; a table has rows on lines, cells joined by ` | `. */
  text: string;
  /** 0 for top-level blocks, +1 per nesting level of `children`. */
  depth: number;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** Plain text of inline content (styled text, links, custom inline types). */
function inlineText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let out = '';
  for (const item of content) {
    if (typeof item === 'string') {
      out += item;
    } else if (isRecord(item)) {
      if (typeof item.text === 'string') out += item.text;
      else if (Array.isArray(item.content)) out += inlineText(item.content);
      // A page link reads as its title (`pageLinkConfig`).
      else if (item.type === 'pageLink' && isRecord(item.props)) out += String(item.props.title ?? '');
      // A mention reads as `@name` (`mentionConfig`).
      else if (item.type === 'mention' && isRecord(item.props)) out += `@${String(item.props.name ?? '')}`;
    }
  }
  return out;
}

/** A cell is either an inline array or `{ type: 'tableCell', content: [...] }`. */
function cellText(cell: unknown): string {
  if (Array.isArray(cell) || typeof cell === 'string') return inlineText(cell);
  if (isRecord(cell)) return inlineText(cell.content);
  return '';
}

function tableText(content: Record<string, unknown>): string {
  const rows = Array.isArray(content.rows) ? content.rows : [];
  return rows
    .map((row) => {
      const cells = isRecord(row) && Array.isArray(row.cells) ? row.cells : [];
      return cells.map(cellText).join(' | ');
    })
    .join('\n');
}

function blockText(content: unknown): string {
  if (isRecord(content) && !Array.isArray(content) && content.type === 'tableContent') {
    return tableText(content);
  }
  return inlineText(content);
}

/** Depth-first, document-order flattening; children follow their parent at depth + 1. */
export function flattenBlocks(blocks: BlockLike[]): FlatBlock[] {
  const out: FlatBlock[] = [];
  const walk = (list: BlockLike[], depth: number) => {
    for (const b of list) {
      const flat: FlatBlock = { id: b.id, type: b.type, text: blockText(b.content), depth };
      if (b.type === 'heading') {
        const level = Number(b.props?.level);
        flat.level = Number.isInteger(level) && level >= 1 ? level : 1;
      }
      out.push(flat);
      if (Array.isArray(b.children) && b.children.length > 0) walk(b.children, depth + 1);
    }
  };
  walk(blocks, 0);
  return out;
}

/**
 * A block's text with its nested children, one block per line: what the
 * routing engine and collab compare to tell whether a block changed.
 */
export function blockFullText(block: BlockLike): string {
  return flattenBlocks([block])
    .map((b) => b.text)
    .join('\n');
}
