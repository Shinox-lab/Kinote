import { describe, expect, test } from 'vitest';
import * as Y from 'yjs';
import { createServerEditor } from '@living-wiki/shared';
import { changesPage } from '../src/attribution.js';
import { BLOCK_FRAGMENT } from './support/blocks.js';

const editor = createServerEditor();

function page() {
  const doc = editor.blocksToYDoc([{ type: 'paragraph', content: 'Hello world' } as any], BLOCK_FRAGMENT);
  const find = (n: Y.XmlFragment | Y.XmlElement): Y.XmlText | undefined => {
    for (const c of n.toArray()) {
      if (c instanceof Y.XmlText) return c;
      const f = c instanceof Y.XmlElement ? find(c) : undefined;
      if (f) return f;
    }
  };
  return { doc, text: find(doc.getXmlFragment(BLOCK_FRAGMENT))! };
}

/** Whether each transaction `fn` makes changes the page, judged as it happens (as the recorder does). */
function changesOf(doc: Y.Doc, fn: () => void): boolean[] {
  const seen: boolean[] = [];
  const on = (tx: Y.Transaction) => seen.push(changesPage(tx));
  doc.on('afterTransaction', on);
  fn();
  doc.off('afterTransaction', on);
  return seen;
}

describe('comment marks are not page edits', () => {
  test('adding, flipping and removing a comment mark changes nothing on the page', () => {
    const { doc, text } = page();
    const changes = changesOf(doc, () => {
      text.format(0, 5, { comment: { threadId: 't1', orphan: false } });
      text.format(0, 5, { comment: { threadId: 't1', orphan: true } });
      text.format(0, 5, { comment: null });
    });
    expect(changes).toEqual([false, false, false]);
  });

  test('bold, or typing, is still an edit', () => {
    const { doc, text } = page();
    const changes = changesOf(doc, () => {
      text.format(0, 5, { bold: true });
      text.insert(0, 'Oh ');
    });
    expect(changes).toEqual([true, true]);
  });

  test('a comment mark in the same transaction as typing is an edit', () => {
    const { doc, text } = page();
    const changes = changesOf(doc, () => {
      doc.transact(() => {
        text.format(0, 5, { comment: { threadId: 't1', orphan: false } });
        text.insert(11, '!');
      });
    });
    expect(changes).toEqual([true]);
  });
});
