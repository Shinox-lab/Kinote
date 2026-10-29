import { describe, expect, test } from 'vitest';
import {
  compareRows,
  defaultView,
  groupKeysOf,
  parseViews,
  prefill,
  rowMatches,
  type FieldDef,
  type ViewFilter,
} from '../src/index.js';

const ME = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const PAGE = '33333333-3333-4333-8333-333333333333';

const f = (id: string, type: FieldDef['type'], options: FieldDef['options'] = {}): FieldDef => ({ id, name: id, type, options, position: 'p0000' });
const status = f('status', 'select', {
  choices: [
    { id: 'lead', name: 'Lead', color: 'gray' },
    { id: 'active', name: 'Active', color: 'green' },
  ],
});
const tags = f('tags', 'multi_select', { choices: [{ id: 'vip', name: 'VIP', color: 'red' }] });
const owner = f('owner', 'person');
const launch = f('launch', 'date');
const count = f('count', 'number');
const note = f('note', 'text');
const done = f('done', 'checkbox');
const related = f('related', 'page');
const defs = [status, tags, owner, launch, count, note, done, related];
const ctx = { me: ME, today: '2026-10-29' }; // a Thursday

const row = (title: string, values: Record<string, unknown>) => ({ title, values });
const matches = (r: ReturnType<typeof row>, ...filters: ViewFilter[]) => rowMatches(defs, r, filters, ctx);

describe('rowMatches', () => {
  const george = row('George', {
    status: 'active',
    tags: ['vip'],
    owner: [ME],
    launch: { start: '2026-11-02', end: '2026-11-06' },
    count: 3,
    note: 'Hero video swap',
    done: true,
    related: [PAGE],
  });
  const bare = row('Tavros', {});

  test('each operator, per type', () => {
    expect(matches(george, { fieldId: 'status', op: 'is', value: 'active' })).toBe(true);
    expect(matches(george, { fieldId: 'status', op: 'is_not', value: 'active' })).toBe(false);
    expect(matches(bare, { fieldId: 'status', op: 'is_empty' })).toBe(true);
    expect(matches(george, { fieldId: 'tags', op: 'contains', value: 'vip' })).toBe(true);
    expect(matches(george, { fieldId: 'tags', op: 'not_contains', value: 'vip' })).toBe(false);
    expect(matches(george, { fieldId: 'owner', op: 'contains', value: 'me' })).toBe(true);
    expect(matches(george, { fieldId: 'owner', op: 'contains', value: OTHER })).toBe(false);
    expect(matches(george, { fieldId: 'count', op: 'gt', value: 2 })).toBe(true);
    expect(matches(george, { fieldId: 'count', op: 'lt', value: 2 })).toBe(false);
    expect(matches(george, { fieldId: 'count', op: 'eq', value: 3 })).toBe(true);
    expect(matches(george, { fieldId: 'count', op: 'ne', value: 3 })).toBe(false);
    expect(matches(george, { fieldId: 'note', op: 'contains', value: 'video' })).toBe(true);
    expect(matches(george, { fieldId: 'note', op: 'is', value: 'hero video swap' })).toBe(true);
    expect(matches(george, { fieldId: 'done', op: 'checked' })).toBe(true);
    expect(matches(bare, { fieldId: 'done', op: 'unchecked' })).toBe(true);
    expect(matches(george, { fieldId: 'related', op: 'contains', value: PAGE })).toBe(true);
    expect(matches(bare, { fieldId: 'related', op: 'is_empty' })).toBe(true);
    expect(matches(george, { fieldId: 'title', op: 'contains', value: 'geo' })).toBe(true);
  });

  test('dates: a day inside the range, before, after, and windows around today', () => {
    expect(matches(george, { fieldId: 'launch', op: 'is', value: '2026-11-04' })).toBe(true);
    expect(matches(george, { fieldId: 'launch', op: 'before', value: '2026-11-03' })).toBe(true);
    expect(matches(george, { fieldId: 'launch', op: 'after', value: '2026-11-05' })).toBe(true);
    expect(matches(george, { fieldId: 'launch', op: 'after', value: '2026-11-06' })).toBe(false);
    expect(matches(george, { fieldId: 'launch', op: 'this_week' })).toBe(false);
    expect(matches(george, { fieldId: 'launch', op: 'next_month' })).toBe(true);
    expect(matches(row('x', { launch: { start: '2026-10-26' } }), { fieldId: 'launch', op: 'this_week' })).toBe(true);
    expect(matches(row('x', { launch: { start: '2026-10-01' } }), { fieldId: 'launch', op: 'this_month' })).toBe(true);
  });

  test('all filters must match (AND)', () => {
    expect(matches(george, { fieldId: 'status', op: 'is', value: 'active' }, { fieldId: 'done', op: 'unchecked' })).toBe(false);
  });

  test('a filter on a removed field, a wrong op or a bad value is ignored', () => {
    expect(matches(bare, { fieldId: 'gone', op: 'is', value: 'x' })).toBe(true);
    expect(matches(bare, { fieldId: 'status', op: 'gt', value: 1 })).toBe(true);
    expect(matches(bare, { fieldId: 'count', op: 'gt', value: 'many' })).toBe(true);
  });

  test('a value that doesn’t fit its field counts as empty', () => {
    expect(matches(row('x', { count: 'three' }), { fieldId: 'count', op: 'is_empty' })).toBe(true);
  });
});

describe('compareRows', () => {
  const rows = [
    row('B', { count: 2, status: 'active' }),
    row('A', { count: 10 }),
    row('C', { count: 1, status: 'lead' }),
  ];
  test('by title, by a number, by choice order; empties last either way', () => {
    expect([...rows].sort(compareRows(defs, [{ fieldId: 'title', dir: 'asc' }])).map((r) => r.title)).toEqual(['A', 'B', 'C']);
    expect([...rows].sort(compareRows(defs, [{ fieldId: 'count', dir: 'desc' }])).map((r) => r.title)).toEqual(['A', 'B', 'C']);
    expect([...rows].sort(compareRows(defs, [{ fieldId: 'status', dir: 'asc' }])).map((r) => r.title)).toEqual(['C', 'B', 'A']);
    expect([...rows].sort(compareRows(defs, [{ fieldId: 'status', dir: 'desc' }])).map((r) => r.title)).toEqual(['B', 'C', 'A']);
  });
  test('a sort on a removed field is ignored; title breaks ties', () => {
    expect([...rows].sort(compareRows(defs, [{ fieldId: 'gone', dir: 'asc' }])).map((r) => r.title)).toEqual(['A', 'B', 'C']);
  });
});

describe('prefill', () => {
  test('a new row gets the single values the filters pin, so it stays in view', () => {
    expect(
      prefill(defs, [
        { fieldId: 'status', op: 'is', value: 'active' },
        { fieldId: 'owner', op: 'contains', value: 'me' },
        { fieldId: 'done', op: 'checked' },
        { fieldId: 'launch', op: 'is', value: '2026-11-04' },
        { fieldId: 'count', op: 'gt', value: 2 },
        { fieldId: 'status', op: 'is_not', value: 'lead' },
      ], ME)
    ).toEqual({ status: 'active', owner: [ME], done: true, launch: { start: '2026-11-04' } });
  });
});

describe('groupKeysOf', () => {
  test('one column per value, "" for none', () => {
    expect(groupKeysOf(status, 'active')).toEqual(['active']);
    expect(groupKeysOf(status, undefined)).toEqual(['']);
    expect(groupKeysOf(owner, [ME, OTHER])).toEqual([ME, OTHER]);
    expect(groupKeysOf(done, true)).toEqual(['true']);
    expect(groupKeysOf(done, undefined)).toEqual(['false']);
  });
});

describe('parseViews', () => {
  test('garbage falls back to one table; a good list is kept', () => {
    expect(parseViews('not json')).toEqual([defaultView()]);
    expect(parseViews('[]')).toEqual([defaultView()]);
    expect(parseViews(JSON.stringify([{ id: 'v1', layout: 'spreadsheet' }]))).toEqual([defaultView()]);
    const board = { ...defaultView('board'), id: 'v2', name: 'By status', groupBy: 'status' };
    expect(parseViews(JSON.stringify([board]))).toEqual([board]);
  });
  test('missing settings get their defaults', () => {
    expect(parseViews(JSON.stringify([{ id: 'v1', name: 'All', layout: 'table' }]))[0]).toMatchObject({
      filters: [],
      sorts: [],
      groupBy: null,
      visible: null,
    });
  });
});
