import * as Y from 'yjs';
import { useCreateBlockNote } from '@blocknote/react';
import { BlockNoteView } from '@blocknote/mantine';
import '@blocknote/core/fonts/inter.css';
import '@blocknote/mantine/style.css';
import { useResolvedTheme } from '../lib/useResolvedTheme.js';
import { loadSession } from '../lib/session.js';
import type { Live } from '../lib/useLivePage.js';
import { authorColor } from '../lib/wiki.js';
import { Button, ErrorNote, Loading } from './ui.js';

/** The Y.XmlFragment that holds a page's blocks (BLOCK_FRAGMENT in apps/collab/src/fragment.ts). */
const BLOCK_FRAGMENT = 'document-store';

/** The BlockNote editor bound to the page's Yjs document. Mounted only once the provider exists. */
function BoundEditor({ live, editable }: { live: Live; editable: boolean }) {
  const user = loadSession()?.user;
  const editor = useCreateBlockNote(
    {
      collaboration: {
        // BlockNote only reads the awareness (cursors); the provider types it as nullable.
        provider: { awareness: live.provider.awareness ?? undefined },
        fragment: live.ydoc.getXmlFragment(BLOCK_FRAGMENT),
        user: { name: user?.name ?? 'Someone', color: authorColor(user?.id ?? '').accent },
      },
    },
    [live]
  );
  const theme = useResolvedTheme();
  return <BlockNoteView editor={editor} editable={editable} theme={theme} />;
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
}: {
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
  return (
    <div className="flex flex-col gap-2">
      {!editable && live && <span className="w-fit rounded-full bg-hover px-2 py-0.5 text-xs text-fg">Read only</span>}
      {/* BlockNote indents its blocks to leave room for the side handles. Where the column has margin to spare
          (a screen wide enough for the sidebar and the page plus the indent) the indent hangs in the margin,
          so the text lines up with the title; narrower, it stays inside and nothing scrolls sideways. */}
      <div className="min-h-[16rem] min-[1100px]:-mx-[54px]">
        {live ? <BoundEditor live={live} editable={editable} /> : <Loading what="editor" />}
      </div>
    </div>
  );
}
