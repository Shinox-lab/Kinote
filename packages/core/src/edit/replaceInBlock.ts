import type { BlockLike } from '@kinote/shared';

/** Top-level block types whose own text `kinote_edit` may change (tables, media, drawings and the like are not). */
export const EDITABLE_BLOCK_TYPES: ReadonlySet<string> = new Set([
  'paragraph',
  'heading',
  'bulletListItem',
  'numberedListItem',
  'checkListItem',
  'quote',
  'codeBlock',
]);

/** One leaf of a block's inline content: styled text (inside link `link` when set), or a node kept as it is. */
type Leaf =
  | { kind: 'text'; text: string; styles: unknown; link: number | null }
  | { kind: 'other'; node: unknown };

interface LinkNode {
  type: 'link';
  href: string;
  content: unknown[];
  [k: string]: unknown;
}

const isText = (n: unknown): n is { type: 'text'; text: string; styles?: unknown } =>
  !!n && typeof n === 'object' && (n as { type?: unknown }).type === 'text' && typeof (n as { text?: unknown }).text === 'string';
const isLink = (n: unknown): n is LinkNode =>
  !!n && typeof n === 'object' && (n as { type?: unknown }).type === 'link' && Array.isArray((n as { content?: unknown }).content);

function leavesOf(content: unknown[]): { leaves: Leaf[]; links: LinkNode[] } {
  const leaves: Leaf[] = [];
  const links: LinkNode[] = [];
  for (const node of content) {
    if (isText(node)) leaves.push({ kind: 'text', text: node.text, styles: node.styles ?? {}, link: null });
    else if (isLink(node)) {
      const at = links.push(node) - 1;
      for (const inner of node.content) {
        if (isText(inner)) leaves.push({ kind: 'text', text: inner.text, styles: inner.styles ?? {}, link: at });
      }
    } else leaves.push({ kind: 'other', node });
  }
  return { leaves, links };
}

function rebuild(leaves: Leaf[], links: LinkNode[]): unknown[] {
  const out: unknown[] = [];
  let open: { at: number; node: LinkNode } | null = null;
  for (const leaf of leaves) {
    if (leaf.kind === 'other') {
      open = null;
      out.push(leaf.node);
      continue;
    }
    if (leaf.text === '') continue;
    const text = { type: 'text', text: leaf.text, styles: leaf.styles };
    if (leaf.link === null) {
      open = null;
      out.push(text);
    } else if (open && open.at === leaf.link) {
      open.node.content.push(text);
    } else {
      open = { at: leaf.link, node: { ...links[leaf.link]!, content: [text] } };
      out.push(open.node);
    }
  }
  return out;
}

function occurrences(haystack: string, needle: string): number[] {
  const at: number[] = [];
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) at.push(i);
  return at;
}

/**
 * Replaces the one occurrence of `old` in the block's own inline text (its children are neither searched nor
 * changed) with `next`, keeping links and styles outside the replaced span. The new text takes the styles and
 * link of the run where `old` starts. Not found, or found more than once, changes nothing.
 */
export function replaceInBlock(
  block: BlockLike,
  old: string,
  next: string
): { ok: true; block: BlockLike } | { ok: false; reason: 'not_found' | 'ambiguous'; count: number } {
  const content = Array.isArray(block.content) ? (block.content as unknown[]) : [];
  const { leaves, links } = leavesOf(content);
  const joined = leaves.map((l) => (l.kind === 'text' ? l.text : '')).join('');
  const found = old === '' ? [] : occurrences(joined, old);
  if (found.length === 0) return { ok: false, reason: 'not_found', count: 0 };
  if (found.length > 1) return { ok: false, reason: 'ambiguous', count: found.length };

  const start = found[0]!;
  const end = start + old.length;
  let pos = 0;
  let inserted = false;
  const edited: Leaf[] = leaves.map((leaf) => {
    if (leaf.kind !== 'text') return leaf;
    const from = pos;
    const to = pos + leaf.text.length;
    pos = to;
    if (to <= start || from >= end) return leaf;
    const keepHead = leaf.text.slice(0, Math.max(0, start - from));
    const keepTail = leaf.text.slice(Math.max(0, end - from));
    const middle = inserted ? '' : next;
    inserted = true;
    return { ...leaf, text: keepHead + middle + keepTail };
  });
  return { ok: true, block: { ...block, content: rebuild(edited, links) } };
}
