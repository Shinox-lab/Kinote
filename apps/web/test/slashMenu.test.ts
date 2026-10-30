import { describe, expect, test } from 'vitest';
import { withExtras } from '../src/components/editor/menus.js';

const item = (title: string, group: string) => ({ title, group });

describe('withExtras', () => {
  test('each extra joins its group, so no group heading shows twice', () => {
    const defaults = [item('Heading', 'Headings'), item('Paragraph', 'Basic blocks'), item('Table', 'Basic blocks'), item('Emoji', 'Others')];
    const extras = [item('Link to page', 'Pages'), item('Callout', 'Basic blocks'), item('Drawing', 'Basic blocks'), item('New sub-page', 'Pages')];
    expect(withExtras(defaults, extras).map((i) => `${i.group}:${i.title}`)).toEqual([
      'Headings:Heading',
      'Basic blocks:Paragraph',
      'Basic blocks:Table',
      'Basic blocks:Callout',
      'Basic blocks:Drawing',
      'Others:Emoji',
      'Pages:Link to page',
      'Pages:New sub-page',
    ]);
  });
});
