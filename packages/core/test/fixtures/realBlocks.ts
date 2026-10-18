import { ServerBlockNoteEditor } from '@blocknote/server-util';

/** A real BlockNote block, exactly as `yDocToBlocks` returns it. */
export type RealBlock = Awaited<
  ReturnType<ServerBlockNoteEditor['tryParseMarkdownToBlocks']>
>[number];

const editor = ServerBlockNoteEditor.create();

/** Builds real BlockNote blocks (generated ids included) from markdown. */
export async function blocksFromMarkdown(md: string): Promise<RealBlock[]> {
  return editor.tryParseMarkdownToBlocks(md);
}
