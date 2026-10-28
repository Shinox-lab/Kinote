import { useEffect, useRef } from 'react';
import { CommentsExtension } from '@blocknote/core/comments';
import { useCreateBlockNote } from '@blocknote/react';
import { BlockNoteView } from '@blocknote/mantine';
import '@blocknote/core/fonts/inter.css';
import '@blocknote/mantine/style.css';
import '../editor.css';
import { useResolvedTheme } from '../lib/useResolvedTheme.js';
import { loadSession } from '../lib/session.js';
import type { Live } from '../lib/useLivePage.js';
import { authorColor } from '../lib/wiki.js';
import type { ApiThreadStore } from '../lib/threadStore.js';
import { useThreads } from '../lib/useThreadStore.js';
import { usePeek } from '../lib/usePeek.js';
import { Button, ErrorNote, Loading } from './ui.js';
import { blockSourcesExtension, setBlockSources, type BlockSource } from './editor/blockSources.js';
import { linkTriggerExtension } from './editor/linkTrigger.js';
import { WikiMenus, type EditorPlace } from './editor/menus.js';
import { wikiSchema } from './editor/schema.js';

export type { BlockSource, EditorPlace };

/** A store with no threads, for an editor without comments (hooks can't be skipped). */
const NO_THREADS = { subscribe: () => () => undefined, getThreads: () => EMPTY_THREADS } as unknown as ApiThreadStore;
const EMPTY_THREADS = new Map();

/** The Y.XmlFragment that holds a page's blocks (BLOCK_FRAGMENT in apps/collab/src/fragment.ts). */
const BLOCK_FRAGMENT = 'document-store';

/** The BlockNote editor bound to the page's Yjs document. Mounted only once the provider exists. */
function BoundEditor({
  live,
  editable,
  place,
  sources,
  threads,
}: {
  live: Live;
  editable: boolean;
  place: EditorPlace;
  sources: BlockSource[];
  threads?: ApiThreadStore;
}) {
  const user = loadSession()?.user;
  const peek = usePeek();
  // The chips are made once per editor; they open whatever page the latest render says.
  const openRef = useRef(peek.open);
  openRef.current = peek.open;
  const editor = useCreateBlockNote(
    {
      schema: wikiSchema,
      collaboration: {
        // BlockNote only reads the awareness (cursors); the provider types it as nullable.
        provider: { awareness: live.provider.awareness ?? undefined },
        fragment: live.ydoc.getXmlFragment(BLOCK_FRAGMENT),
        user: { name: user?.name ?? 'Someone', color: authorColor(user?.id ?? '').accent },
      },
      extensions: [
        blockSourcesExtension((pageId) => openRef.current(pageId)),
        linkTriggerExtension(),
        ...(threads
          ? [
              CommentsExtension({
                threadStore: threads,
                resolveUsers: async (ids: string[]) =>
                  ids.map((id) => ({ id, username: threads.userName(id) ?? 'Someone', avatarUrl: '' })),
              }),
            ]
          : []),
      ],
    },
    [live, threads]
  );
  // A new thread remembers the block and the text it was started on.
  useEffect(() => {
    threads?.setWhere(() => ({
      blockId: editor.getTextCursorPosition().block.id,
      quote: editor.getSelectedText() || null,
    }));
  }, [editor, threads]);
  const sourceKey = sources.map((s) => `${s.blockId}:${s.pageId}:${s.title}`).join('|');
  useEffect(() => {
    setBlockSources(editor, sources);
    // `sources` is a new array on every render; its content is the trigger.
  }, [editor, sourceKey]);
  const theme = useResolvedTheme();
  return (
    <BlockNoteView editor={editor} editable={editable} theme={theme} slashMenu={false}>
      {editable && <WikiMenus editor={editor} place={place} />}
    </BlockNoteView>
  );
}

/**
 * The live editor of one page, on the provider the page's shell opened (the
 * same one the presence reads). The editor is read-only when the token says
 * read or the page is archived; a failed token shows Try again. Connection
 * state and Reconnect live in the top bar's presence, not here.
 */
export function Editor({
  live,
  access,
  archived,
  error,
  retry,
  place,
  sources = [],
  threads,
}: {
  place: EditorPlace;
  /** The page's comment store: comment marks and floating threads; none for no comments. */
  threads?: ApiThreadStore;
  /** Blocks the routing engine changed from a document page, shown with a "From:" chip. */
  sources?: BlockSource[];
  live: Live | null;
  access: 'read' | 'write';
  archived: boolean;
  error: unknown;
  retry: () => void;
}) {
  if (error) {
    return (
      <div className="flex flex-col items-start gap-2">
        <ErrorNote error={error} />
        <Button variant="secondary" onClick={retry}>
          Try again
        </Button>
      </div>
    );
  }

  const editable = access === 'write' && !archived;
  // The editor waits for the first thread answer: BlockNote marks every comment it doesn't know as orphaned.
  useThreads(threads ?? NO_THREADS);
  const threadsReady = !threads || threads.loaded;
  return (
    <div className="flex flex-col gap-2">
      {!editable && live && <span className="w-fit rounded-full bg-hover px-2 py-0.5 text-xs text-fg">Read only</span>}
      {/* BlockNote indents its blocks to leave room for the side handles. Where the column has margin to spare
          (a screen wide enough for the sidebar and the page plus the indent) the indent hangs in the margin,
          so the text lines up with the title; narrower, it stays inside and nothing scrolls sideways. */}
      <div className="min-h-[16rem] min-[1100px]:-mx-[54px]">
        {live && threadsReady ? (
          <BoundEditor live={live} editable={editable} place={place} sources={sources} threads={threads} />
        ) : (
          <Loading what="editor" />
        )}
      </div>
    </div>
  );
}
