import { SuggestionMenu, filterSuggestionItems } from '@blocknote/core';
import {
  SuggestionMenuController,
  getDefaultReactSlashMenuItems,
  type DefaultReactSuggestionItem,
} from '@blocknote/react';
import { defaultView } from '@kinote/contracts';
import { api } from '../../lib/api.js';
import { linkMenuEntries } from '../../lib/links.js';
import { createNamedPage } from '../../lib/newPage.js';
import { useRefresh } from '../../lib/queries.js';
import { LINK_TRIGGER } from './linkTrigger.js';
import type { WikiEditor } from './schema.js';
import { drawingMenuItem, useLiveDoc } from '../drawing/drawingRules.js';
import { CalloutIcon, CollectionViewIcon, DrawingIcon, LinkIcon, MentionIcon, SubPageIcon } from '../icons.js';

/** The size of BlockNote's own slash menu icons. */
const MENU_ICON = { width: 18, height: 18 };


/** Where the page being edited lives: new pages made from a menu go under it. */
export interface EditorPlace {
  pageId: string;
  spaceId: string;
}

/** Each extra goes after the last item of its group, so every group heading shows once. */
export function withExtras<T extends { group?: string }>(items: T[], extras: T[]): T[] {
  const out = [...items];
  for (const extra of extras) {
    let at = out.length - 1;
    while (at >= 0 && out[at]!.group !== extra.group) at -= 1;
    out.splice(at < 0 ? out.length : at + 1, 0, extra);
  }
  return out;
}

function insertLink(editor: WikiEditor, documentId: string, title: string) {
  editor.insertInlineContent([{ type: 'pageLink', props: { documentId, title } }, ' ']);
}

/**
 * The `[[` page picker, the `@` mention picker and the slash menu with the
 * wiki's extras (Link to page, New sub-page, Mention a person, Callout, Drawing).
 * Only for an editable editor.
 */
export function WikiMenus({ editor, place }: { editor: WikiEditor; place: EditorPlace }) {
  const refresh = useRefresh();
  const live = useLiveDoc();

  // A page that can't be made (no rights, offline) leaves the text as it was. The link goes into the
  // block the person asked from, even if they moved on while the page was being made.
  const newChildPage = (title: string) => {
    const asked = editor.getTextCursorPosition().block;
    return createNamedPage({ space_id: place.spaceId, parent_id: place.pageId, title }).then(
      (page) => {
        void refresh('tree', place.spaceId);
        const here = editor.getTextCursorPosition().block;
        if (here.id !== asked.id && editor.getBlock(asked.id)) editor.setTextCursorPosition(asked.id, 'end');
        insertLink(editor, page.id, page.title);
      },
      (err) => console.warn('[editor] new page failed', err)
    );
  };

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
        icon: <LinkIcon {...MENU_ICON} />,
        aliases: ['link', 'page', '[['],
        group: 'Pages',
        onItemClick: () =>
          editor.getExtension(SuggestionMenu)?.openSuggestionMenu(LINK_TRIGGER, {
            deleteTriggerCharacter: true,
            ignoreQueryLength: true,
          }),
      },
      {
        title: 'Callout',
        subtext: 'A note that stands out',
        icon: <CalloutIcon {...MENU_ICON} />,
        aliases: ['callout', 'note', 'tip', 'warning'],
        group: 'Basic blocks',
        onItemClick: () => {
          const here = editor.getTextCursorPosition().block;
          const empty = Array.isArray(here.content) && here.content.length === 0;
          // An empty line becomes the callout; otherwise it goes below.
          if (empty) editor.updateBlock(here, { type: 'callout', props: { emoji: '💡' } });
          else {
            const [made] = editor.insertBlocks([{ type: 'callout', props: { emoji: '💡' } }], here, 'after');
            if (made) editor.setTextCursorPosition(made, 'end');
          }
        },
      },
      { ...drawingMenuItem(editor, live?.ydoc ?? null), icon: <DrawingIcon {...MENU_ICON} /> },
      {
        title: 'Collection view',
        subtext: 'A table, board, calendar or timeline of a collection',
        icon: <CollectionViewIcon {...MENU_ICON} />,
        aliases: ['collection', 'database', 'table', 'board', 'calendar', 'timeline', 'view'],
        group: 'Pages',
        onItemClick: () => {
          const here = editor.getTextCursorPosition().block;
          // The block goes in now, so nothing typed meanwhile is lost; on a collection page it then
          // shows its own sub-pages, elsewhere it asks which collection.
          const block = { type: 'collectionView' as const, props: { collectionId: '', title: '', views: '' } };
          const empty = Array.isArray(here.content) && here.content.length === 0;
          const [made] = empty ? editor.replaceBlocks([here], [block]).insertedBlocks : editor.insertBlocks([block], here, 'after');
          if (!made) return;
          void api
            .getCollection(place.pageId)
            .then((c) => {
              const now = editor.getBlock(made.id);
              if (now?.type === 'collectionView' && !now.props.collectionId) {
                editor.updateBlock(now, { props: { collectionId: c.id, views: JSON.stringify([defaultView()]) } });
              }
            })
            .catch(() => undefined);
        },
      },
      {
        title: 'Mention a person',
        subtext: 'Tell someone about this',
        icon: <MentionIcon {...MENU_ICON} />,
        aliases: ['mention', 'person', '@'],
        group: 'Pages',
        onItemClick: () =>
          editor.getExtension(SuggestionMenu)?.openSuggestionMenu('@', { deleteTriggerCharacter: true, ignoreQueryLength: true }),
      },
      {
        title: 'New sub-page',
        subtext: 'A page under this one, linked here',
        icon: <SubPageIcon {...MENU_ICON} />,
        aliases: ['subpage', 'child', 'page'],
        group: 'Pages',
        onItemClick: () => void newChildPage('Untitled'),
      },
    ];
    return filterSuggestionItems(withExtras(getDefaultReactSlashMenuItems(editor), extras), query);
  };

  // `@`: people first (greyed when they can't read this page: they would not be told), then pages.
  const mentionItems = async (query: string): Promise<DefaultReactSuggestionItem[]> => {
    const [people, pages] = await Promise.all([
      api.mentionable(place.pageId, query).catch(() => []),
      query.trim() ? api.linkTargets(query).catch(() => []) : Promise.resolve([]),
    ]);
    return [
      ...people.map((p) => ({
        title: p.name,
        subtext: p.canRead ? undefined : 'No access to this space',
        group: 'People',
        onItemClick: () => editor.insertInlineContent([{ type: 'mention', props: { userId: p.userId, name: p.name } }, ' ']),
      })),
      ...linkMenuEntries(pages.slice(0, 3), query, { canCreate: false, selfId: place.pageId }).flatMap((entry) =>
        entry.kind === 'target'
          ? [
              {
                title: entry.title,
                subtext: entry.subtext,
                group: 'Pages',
                onItemClick: () => insertLink(editor, entry.target.id, entry.target.title),
              },
            ]
          : []
      ),
    ];
  };

  return (
    <>
      <SuggestionMenuController triggerCharacter="@" getItems={mentionItems} />
      <SuggestionMenuController triggerCharacter="/" getItems={slashItems} />
      <SuggestionMenuController triggerCharacter={LINK_TRIGGER} getItems={linkItems} />
    </>
  );
}
