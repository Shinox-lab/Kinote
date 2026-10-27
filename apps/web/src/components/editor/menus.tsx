import { SuggestionMenu, filterSuggestionItems } from '@blocknote/core';
import {
  SuggestionMenuController,
  getDefaultReactSlashMenuItems,
  type DefaultReactSuggestionItem,
} from '@blocknote/react';
import { api } from '../../lib/api.js';
import { linkMenuEntries } from '../../lib/links.js';
import { createNamedPage } from '../../lib/newPage.js';
import { useRefresh } from '../../lib/queries.js';
import { LINK_TRIGGER } from './linkTrigger.js';
import type { WikiEditor } from './schema.js';


/** Where the page being edited lives: new pages made from a menu go under it. */
export interface EditorPlace {
  pageId: string;
  spaceId: string;
}

function insertLink(editor: WikiEditor, documentId: string, title: string) {
  editor.insertInlineContent([{ type: 'pageLink', props: { documentId, title } }, ' ']);
}

/**
 * The `[[` page picker and the slash menu with the wiki's extras (Link to
 * page, New sub-page). Only for an editable editor.
 */
export function WikiMenus({ editor, place }: { editor: WikiEditor; place: EditorPlace }) {
  const refresh = useRefresh();

  // A page that can't be made (no rights, offline) leaves the text as it was.
  const newChildPage = (title: string) =>
    createNamedPage({ space_id: place.spaceId, parent_id: place.pageId, title }).then(
      (page) => {
        void refresh('tree', place.spaceId);
        insertLink(editor, page.id, page.title);
      },
      (err) => console.warn('[editor] new page failed', err)
    );

  const linkItems = async (query: string): Promise<DefaultReactSuggestionItem[]> => {
    const targets = await api.linkTargets(query).catch(() => []);
    return linkMenuEntries(targets, query, { canCreate: true, selfId: place.pageId }).map((entry) =>
      entry.kind === 'target'
        ? {
            title: entry.title,
            subtext: entry.subtext,
            icon: entry.target.icon ? <span aria-hidden="true">{entry.target.icon}</span> : undefined,
            onItemClick: () => insertLink(editor, entry.target.id, entry.target.title),
          }
        : { title: entry.title, subtext: 'Under this page', onItemClick: () => void newChildPage(entry.newTitle) }
    );
  };

  const slashItems = async (query: string): Promise<DefaultReactSuggestionItem[]> => {
    const extras: DefaultReactSuggestionItem[] = [
      {
        title: 'Link to page',
        subtext: 'Link to another page',
        aliases: ['link', 'page', '[['],
        group: 'Pages',
        onItemClick: () =>
          editor.getExtension(SuggestionMenu)?.openSuggestionMenu(LINK_TRIGGER, {
            deleteTriggerCharacter: true,
            ignoreQueryLength: true,
          }),
      },
      {
        title: 'New sub-page',
        subtext: 'A page under this one, linked here',
        aliases: ['subpage', 'child', 'page'],
        group: 'Pages',
        onItemClick: () => void newChildPage('Untitled'),
      },
    ];
    return filterSuggestionItems([...getDefaultReactSlashMenuItems(editor), ...extras], query);
  };

  return (
    <>
      <SuggestionMenuController triggerCharacter="/" getItems={slashItems} />
      <SuggestionMenuController triggerCharacter={LINK_TRIGGER} getItems={linkItems} />
    </>
  );
}
