import { SuggestionMenu, createExtension } from '@blocknote/core';
import { Plugin } from 'prosemirror-state';

export const LINK_TRIGGER = '[[';

/**
 * Opens the `[[` menu when a second `[` is typed. BlockNote 0.49 matches a
 * two-character trigger against three characters (the two before the caret
 * plus the typed one), so its own check never fires for `[[`.
 */
export const linkTriggerExtension = createExtension(({ editor }: { editor: any }) => ({
  key: 'linkTrigger',
  prosemirrorPlugins: [
    new Plugin({
      props: {
        handleTextInput(view, from, to, text) {
          if (text !== '[' || from !== to || from < 1) return false;
          if (view.state.doc.textBetween(from - 1, from) !== '[') return false;
          // In code (`[[ -f x ]]`, `[[1, 2]]`) brackets are just brackets.
          const $from = view.state.doc.resolve(from);
          if ($from.parent.type.spec.code || $from.marks().some((m) => m.type.name === 'code')) return false;
          // The first `[` goes; the menu writes the whole trigger back and removes it on close.
          view.dispatch(view.state.tr.delete(from - 1, from));
          editor.getExtension(SuggestionMenu)?.openSuggestionMenu(LINK_TRIGGER, { deleteTriggerCharacter: true });
          return true;
        },
      },
    }),
  ],
}));
