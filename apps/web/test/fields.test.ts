import { describe, expect, test } from 'vitest';
import type { FieldDef } from '@kinote/contracts';
import { emptyFieldCount, fieldDisplay, nextChoiceColor, removalWarning } from '../src/lib/fields.js';

const USER = '11111111-1111-4111-8111-111111111111';
const PAGE = '22222222-2222-4222-8222-222222222222';
const def = (type: FieldDef['type'], options: FieldDef['options'] = {}, id: string = type): FieldDef => ({
  id,
  name: type,
  type,
  options,
  position: 'p0000',
});
const names = { users: new Map([[USER, 'Olive Owner']]), pages: new Map([[PAGE, 'Client - George']]) };

describe('fieldDisplay', () => {
  test('shows each type in words', () => {
    expect(fieldDisplay(def('date'), { start: '2026-12-01' }, names)).toBe('1 December 2026');
    expect(fieldDisplay(def('date'), { start: '2026-12-01', end: '2026-12-05' }, names)).toBe('1–5 December 2026');
    expect(fieldDisplay(def('select', { choices: [{ id: 'a', name: 'Active', color: 'green' }] }), 'a', names)).toBe('Active');
    expect(fieldDisplay(def('person'), [USER], names)).toBe('Olive Owner');
    expect(fieldDisplay(def('page'), [PAGE], names)).toBe('Client - George');
    expect(fieldDisplay(def('checkbox'), true, names)).toBe('Yes');
    expect(fieldDisplay(def('number', { format: 'percent' }), 40, names)).toBe('40%');
    expect(fieldDisplay(def('text'), 'Hello', names)).toBe('Hello');
  });

  test('a value that doesn’t fit shows nothing', () => {
    expect(fieldDisplay(def('number'), 'x', names)).toBeNull();
    expect(fieldDisplay(def('date'), undefined, names)).toBeNull();
  });
});

describe('emptyFieldCount', () => {
  test('counts fields with no value that fits', () => {
    const defs = [def('text', {}, 'a'), def('number', {}, 'b'), def('checkbox', {}, 'c')];
    expect(emptyFieldCount(defs, { a: 'x', b: 'not a number' })).toBe(2);
    expect(emptyFieldCount(defs, { a: 'x', b: 1, c: false })).toBe(0);
  });
});

describe('nextChoiceColor', () => {
  test('cycles through colours not used yet', () => {
    expect(nextChoiceColor([])).toBe('gray');
    expect(nextChoiceColor([{ id: '1', name: 'A', color: 'gray' }])).toBe('brown');
  });
});

describe('removalWarning', () => {
  test('names the field and the pages it clears', () => {
    expect(removalWarning('Launch date', 1)).toBe('Launch date will be removed from 1 page.');
    expect(removalWarning('Launch date', 24)).toBe('Launch date will be removed from 24 pages.');
    expect(removalWarning('Launch date', 0)).toBe('Launch date will be removed. No page has a value for it yet.');
  });
});
