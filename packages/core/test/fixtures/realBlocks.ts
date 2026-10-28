import { createServerEditor } from '@living-wiki/shared';

const editor = createServerEditor();

/** A real BlockNote block, exactly as `yDocToBlocks` returns it. */
export type RealBlock = Awaited<ReturnType<typeof editor.tryParseMarkdownToBlocks>>[number];

/** Builds real BlockNote blocks (generated ids included) from markdown. */
export async function blocksFromMarkdown(md: string): Promise<RealBlock[]> {
  return editor.tryParseMarkdownToBlocks(md);
}
