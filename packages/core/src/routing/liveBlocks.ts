import * as Y from 'yjs';
import { createServerEditor } from '@kinote/shared';
import { and, eq } from 'drizzle-orm';
import { pages, type DbTransaction } from '@kinote/db';
import { flattenBlocks, restorePageLinks, type BlockLike } from '@kinote/shared';
import { FIELDS_MAP } from '@kinote/contracts';

const editor = createServerEditor();

/**
 * The page's live title, top-level blocks and raw field values (the `fields`
 * map, unchecked), read from the stored Yjs state (what collab last stored).
 * Null when the page has no live document.
 */
export async function readLiveBlocks(
  tx: DbTransaction,
  tenantId: string,
  pageId: string
): Promise<{ title: string; blocks: BlockLike[]; fields: Record<string, unknown> } | null> {
  const [row] = await tx
    .select({ ydocState: pages.ydocState })
    .from(pages)
    .where(and(eq(pages.tenantId, tenantId), eq(pages.documentId, pageId)));
  if (!row) return null;
  const doc = new Y.Doc();
  Y.applyUpdate(doc, row.ydocState);
  const title = doc.getMap('meta').get('title');
  return {
    title: typeof title === 'string' ? title : '',
    blocks: editor.yDocToBlocks(doc, 'document-store') as BlockLike[],
    fields: doc.getMap(FIELDS_MAP).toJSON(),
  };
}

/** A top-level block's own plain text (its children are left out). */
export function blockText(block: BlockLike): string {
  return flattenBlocks([{ ...block, children: [] }])[0]?.text ?? '';
}

/**
 * A block's own content as Markdown, its nested children left out: what
 * receipts show before and after, and what Undo compares. Engine replaces
 * keep a block's children, so they are never part of a change.
 */
export async function blockMarkdown(block: BlockLike): Promise<string> {
  return (await editor.blocksToMarkdownLossy([{ ...block, children: [] } as any])).trim();
}

/** BlockNote blocks for engine-written Markdown. */
export async function markdownBlocks(markdown: string): Promise<BlockLike[]> {
  return restorePageLinks((await editor.tryParseMarkdownToBlocks(markdown)) as BlockLike[]);
}

/** A new page's stored Yjs state: `blocks` under `title`. */
export function encodeBlocksYDoc(title: string, blocks: BlockLike[]): Buffer {
  const doc = editor.blocksToYDoc(blocks as any, 'document-store');
  doc.getMap('meta').set('title', title);
  return Buffer.from(Y.encodeStateAsUpdate(doc));
}
