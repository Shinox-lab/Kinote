import * as Y from 'yjs';
import { ServerBlockNoteEditor } from '@blocknote/server-util';
import { and, eq } from 'drizzle-orm';
import { pages, type DbTransaction } from '@living-wiki/db';
import { flattenBlocks, type BlockLike } from '@living-wiki/shared';

const editor = ServerBlockNoteEditor.create();

/**
 * The page's live title and top-level blocks, read from the stored Yjs state
 * (what collab last stored). Null when the page has no live document.
 */
export async function readLiveBlocks(
  tx: DbTransaction,
  tenantId: string,
  pageId: string
): Promise<{ title: string; blocks: BlockLike[] } | null> {
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
  };
}

/** A top-level block's own plain text (its children are left out). */
export function blockText(block: BlockLike): string {
  return flattenBlocks([{ ...block, children: [] }])[0]?.text ?? '';
}

/** A block, children included, as Markdown: what receipts show before and after. */
export async function blockMarkdown(block: BlockLike): Promise<string> {
  return (await editor.blocksToMarkdownLossy([block as any])).trim();
}

/** BlockNote blocks for engine-written Markdown. */
export async function markdownBlocks(markdown: string): Promise<BlockLike[]> {
  return (await editor.tryParseMarkdownToBlocks(markdown)) as BlockLike[];
}

/** A new page's stored Yjs state: `blocks` under `title`. */
export function encodeBlocksYDoc(title: string, blocks: BlockLike[]): Buffer {
  const doc = editor.blocksToYDoc(blocks as any, 'document-store');
  doc.getMap('meta').set('title', title);
  return Buffer.from(Y.encodeStateAsUpdate(doc));
}
