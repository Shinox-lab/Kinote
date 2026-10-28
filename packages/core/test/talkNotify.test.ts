import { describe, expect, it } from 'vitest';
import { excerptOf, textMentions } from '../src/index.js';

const ANN = { id: 'a', name: 'Ann Lee' };
const ANNA = { id: 'b', name: 'Ann' };
const ED = { id: 'e', name: 'Ed Editor' };

describe('textMentions', () => {
  it('finds a member named after @, case aside', () => {
    expect(textMentions('Can @ed editor check this?', [ANN, ED])).toEqual(['e']);
  });

  it('prefers the longest name, and needs a word boundary after it', () => {
    expect(textMentions('@Ann Lee and @Annabel', [ANN, ANNA])).toEqual(['a']);
    expect(textMentions('@Ann, then @Ann Lee', [ANN, ANNA]).sort()).toEqual(['a', 'b']);
  });

  it('a name two members share mentions neither', () => {
    expect(textMentions('@Ed Editor', [ED, { id: 'e2', name: 'Ed Editor' }])).toEqual([]);
  });

  it('no @, no mention', () => {
    expect(textMentions('Ed Editor said so', [ED])).toEqual([]);
  });
});

describe('excerptOf', () => {
  it('folds whitespace and cuts at 160 characters', () => {
    expect(excerptOf(' a\n\n b ')).toBe('a b');
    expect(excerptOf('x'.repeat(200))).toHaveLength(160);
  });
});
