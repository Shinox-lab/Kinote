import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useMutation } from '@tanstack/react-query';
import type { PageDetails } from '@kinote/contracts';
import { api } from '../lib/api.js';
import { startsWithTitleEdit, takeTitleEdit } from '../lib/pageUi.js';
import { PageIconPicker } from './PageIconPicker.js';
import { TitleInput } from './sidebar/TitleInput.js';
import { ErrorNote } from './ui.js';

/**
 * The document's identity: the emoji, the title at 34/600, and a slot for the
 * status/meta row. The top bar keeps the breadcrumb and the page menu. An
 * editor clicks the title to rename it in place; the menu and sidebar use the
 * same call.
 */
export function PageHeader({
  page,
  canEdit,
  meta,
  onRenamed,
}: {
  page: PageDetails;
  canEdit: boolean;
  meta?: ReactNode;
  onRenamed: () => void;
}) {
  const [renaming, setRenaming] = useState(() => startsWithTitleEdit(page.id));
  const shownPage = useRef(page.id);
  const rename = useMutation({
    mutationFn: (title: string) => api.renamePage(page.id, title),
    onSuccess: () => {
      setRenaming(false);
      onRenamed();
    },
    // Keep the old title and let the error note say why; click again to retry.
    onError: () => setRenaming(false),
  });

  // The fresh-page edit is one-shot: saving, cancelling or leaving drops it.
  useEffect(() => {
    if (!renaming) takeTitleEdit(page.id);
  }, [renaming, page.id]);

  useEffect(() => {
    // A different page starts with its own title, not the one being edited; a
    // page just made starts with its title in edit mode. The mount read the
    // mark above already, which also keeps the StrictMode double mount quiet.
    if (shownPage.current === page.id) return;
    shownPage.current = page.id;
    setRenaming(takeTitleEdit(page.id));
    rename.reset();
  }, [page.id]);

  return (
    <header className="flex flex-col gap-2">
      <PageIconPicker pageId={page.id} icon={page.icon} canEdit={canEdit} />
      {renaming ? (
        <TitleInput
          title={page.title}
          onCancel={() => setRenaming(false)}
          onSave={(title) => rename.mutate(title)}
          className="text-[26px] font-semibold leading-[1.12] tracking-[-0.024em] md:text-[2.125rem]"
        />
      ) : (
        <h1 className="break-words text-[26px] font-semibold leading-[1.12] tracking-[-0.024em] md:text-[2.125rem] text-fg">
          {canEdit ? (
            <button
              type="button"
              title="Rename page"
              onClick={() => {
                rename.reset();
                setRenaming(true);
              }}
              className="block w-full rounded px-1 text-left hover:bg-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              {page.title}
            </button>
          ) : (
            page.title
          )}
        </h1>
      )}
      {meta}
      <ErrorNote error={rename.error} />
    </header>
  );
}
