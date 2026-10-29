import { describe, expect, test } from 'vitest';
import { canonicalFieldJson, fieldLines, fieldValueFits, formatFieldValue, validFields, type FieldDef } from '../src/index.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const GONE_USER = '22222222-2222-4222-8222-222222222222';
const PAGE_ID = '33333333-3333-4333-8333-333333333333';

const def = (id: string, name: string, type: FieldDef['type'], options: FieldDef['options'] = {}, position = 'a0'): FieldDef => ({
  id,
  name,
  type,
  options,
  position,
});

const status = def('f-status', 'Status', 'select', {
  choices: [
    { id: 'opt-active', name: 'Active', color: 'green' },
    { id: 'opt-lead', name: 'Lead', color: 'gray' },
  ],
}, 'a0');
const launch = def('f-launch', 'Launch date', 'date', {}, 'a1');
const done = def('f-done', 'Done', 'checkbox', {}, 'a2');
const num = def('f-num', 'Count', 'number');
const price = def('f-price', 'Price', 'number', { format: 'currency', code: 'USD' });
const tags = def('f-tags', 'Tags', 'multi_select', { choices: [{ id: 'opt-a', name: 'A', color: 'blue' }] });
const owner = def('f-owner', 'Owner', 'person');
const related = def('f-related', 'Related', 'page');
const note = def('f-note', 'Note', 'text');

const names = { users: new Map([[USER_ID, 'Olive Owner']]), pages: new Map([[PAGE_ID, 'Client - George']]) };

describe('fieldValueFits', () => {
  test('values fit their type', () => {
    expect(fieldValueFits(launch, { start: '2026-12-01' })).toBe(true);
    expect(fieldValueFits(launch, { start: '2026-12-01', end: '2026-12-05' })).toBe(true);
    expect(fieldValueFits(launch, { start: '2026-12-01T10:00' })).toBe(false);
    expect(fieldValueFits(launch, { start: '2026-12-05', end: '2026-12-01' })).toBe(false);
    expect(fieldValueFits(launch, { start: '2026-02-30' })).toBe(false);
    expect(fieldValueFits(num, 3)).toBe(true);
    expect(fieldValueFits(num, '3')).toBe(false);
    expect(fieldValueFits(num, Number.NaN)).toBe(false);
    expect(fieldValueFits(status, 'opt-active')).toBe(true);
    expect(fieldValueFits(status, 'opt-gone')).toBe(false);
    expect(fieldValueFits(tags, ['opt-a'])).toBe(true);
    expect(fieldValueFits(tags, ['opt-a', 'opt-a'])).toBe(false);
    expect(fieldValueFits(owner, [USER_ID])).toBe(true);
    expect(fieldValueFits(owner, ['not-a-uuid'])).toBe(false);
    expect(fieldValueFits(related, [PAGE_ID])).toBe(true);
    expect(fieldValueFits(done, false)).toBe(true);
    expect(fieldValueFits(done, 'yes')).toBe(false);
    expect(fieldValueFits(note, 'hello')).toBe(true);
    expect(fieldValueFits(note, 5)).toBe(false);
  });

  test('text Postgres can’t store never fits (NUL, lone surrogates)', () => {
    expect(fieldValueFits(note, 'a\u0000b')).toBe(false);
    expect(fieldValueFits(note, 'a\ud800b')).toBe(false);
    expect(fieldValueFits(note, 'emoji 😀 ok')).toBe(true);
  });

  test('empty values never fit: absence is empty', () => {
    expect(fieldValueFits(note, '')).toBe(false);
    expect(fieldValueFits(tags, [])).toBe(false);
    expect(fieldValueFits(owner, [])).toBe(false);
    expect(fieldValueFits(note, null)).toBe(false);
  });
});

describe('validFields', () => {
  test('drops unknown and ill-typed values', () => {
    expect(validFields([num], { [num.id]: 'x', other: 1 })).toEqual({});
    expect(validFields([num, note], { [num.id]: 2, [note.id]: 'hi' })).toEqual({ [num.id]: 2, [note.id]: 'hi' });
  });
});

describe('fieldLines', () => {
  test('prints in field order, in words', () => {
    const raw = { [done.id]: false, [launch.id]: { start: '2026-12-01' }, [status.id]: 'opt-active' };
    expect(fieldLines([done, launch, status], raw, names)).toEqual([
      'Status: Active',
      'Launch date: 2026-12-01 (1 December 2026)',
      'Done: No',
    ]);
  });

  test('formats each type', () => {
    expect(formatFieldValue(launch, { start: '2026-12-01', end: '2026-12-05' }, names)).toBe(
      '2026-12-01 to 2026-12-05 (1–5 December 2026)'
    );
    expect(formatFieldValue(launch, { start: '2026-11-30', end: '2026-12-02' }, names)).toBe(
      '2026-11-30 to 2026-12-02 (30 November – 2 December 2026)'
    );
    expect(formatFieldValue(owner, [GONE_USER], names)).toBeNull();
    expect(formatFieldValue(owner, [USER_ID, GONE_USER], names)).toBe('Olive Owner');
    expect(formatFieldValue(price, 12.5, names)).toBe('USD 12.50');
    expect(formatFieldValue(def('p', 'Share', 'number', { format: 'percent' }), 12, names)).toBe('12%');
    expect(formatFieldValue(def('d', 'Amount', 'number', { format: 'decimal' }), 3, names)).toBe('3.00');
    expect(formatFieldValue(num, 7, names)).toBe('7');
    expect(formatFieldValue(tags, ['opt-a'], names)).toBe('A');
    expect(formatFieldValue(related, [PAGE_ID], names)).toBe('Client - George');
    expect(formatFieldValue(done, true, names)).toBe('Yes');
    expect(formatFieldValue(num, 'x', names)).toBeNull();
  });
});

describe('canonicalFieldJson', () => {
  test('sorts keys and treats undefined as null', () => {
    expect(canonicalFieldJson({ start: '2026-12-01', end: '2026-12-03' })).toBe(canonicalFieldJson({ end: '2026-12-03', start: '2026-12-01' }));
    expect(canonicalFieldJson(undefined)).toBe('null');
    expect(canonicalFieldJson(['b', 'a'])).toBe('["b","a"]'); // arrays keep their order
  });
});
