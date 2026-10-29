import { describe, expect, test } from 'vitest';
import { defaultView, parseViews, type FieldDef } from '@living-wiki/contracts';
import { boardMove, calendarWeeks, editViews, groupRows, localDay, moveDate, replaceView, resizeEnd, tableGroupField, timelineBar, timelineDays, visibleFields } from '../src/lib/views.js';

const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const f = (id: string, type: FieldDef['type'], options: FieldDef['options'] = {}, position = 'p0000'): FieldDef => ({ id, name: id, type, options, position });
const status = f('status', 'select', {
  choices: [
    { id: 'lead', name: 'Lead', color: 'gray' },
    { id: 'active', name: 'Active', color: 'green' },
  ],
});
const owner = f('owner', 'person');
const done = f('done', 'checkbox');
const r = (id: string, values: Record<string, unknown>) => ({ id, title: id, icon: null, values });

describe('groupRows', () => {
  test('select columns follow the choices, then No value', () => {
    const groups = groupRows([r('a', { status: 'active' }), r('b', {}), r('c', { status: 'lead' })], status, { users: new Map(), pages: new Map() });
    expect(groups.map((g) => [g.key, g.label, g.rows.map((x) => x.id)])).toEqual([
      ['lead', 'Lead', ['c']],
      ['active', 'Active', ['a']],
      ['', 'No value', ['b']],
    ]);
  });
  test('a row with two people is in both columns', () => {
    const names = { users: new Map([[U1, 'Ann'], [U2, 'Bo']]), pages: new Map() };
    const groups = groupRows([r('a', { owner: [U1, U2] })], owner, names);
    expect(groups.map((g) => [g.label, g.rows.length])).toEqual([
      ['Ann', 1],
      ['Bo', 1],
      ['No value', 0],
    ]);
  });
  test('checkbox columns are Yes and No', () => {
    expect(groupRows([r('a', { done: true })], done, { users: new Map(), pages: new Map() }).map((g) => g.label)).toEqual(['Yes', 'No']);
  });
});

describe('boardMove', () => {
  test('the new value for a card moved between columns', () => {
    expect(boardMove(status, 'lead', 'lead', 'active')).toBe('active');
    expect(boardMove(status, 'lead', 'lead', '')).toBeNull();
    expect(boardMove(status, 'lead', 'lead', 'lead')).toBeUndefined();
    // "No value" means nobody: the card leaves every person's column.
    expect(boardMove(owner, [U1, U2], U1, '')).toBeNull();
    expect(boardMove(owner, [U1], U1, '')).toBeNull();
    expect(boardMove(owner, [U1], U1, U2)).toEqual([U2]);
    expect(boardMove(owner, [U1, U2], U1, U2)).toEqual([U2]);
    expect(boardMove(owner, undefined, '', U1)).toEqual([U1]);
    expect(boardMove(done, undefined, 'false', 'true')).toBe(true);
    expect(boardMove(done, true, 'true', 'false')).toBe(false);
  });
});

describe('localDay', () => {
  test('the day on the viewer’s own clock, not UTC', () => {
    // Late evening west of UTC (or just after midnight east of it) is another day in UTC.
    expect(localDay(new Date(2026, 9, 29, 23, 30))).toBe('2026-10-29');
    expect(localDay(new Date(2026, 0, 1, 0, 5))).toBe('2026-01-01');
  });
});

describe('tableGroupField', () => {
  test('only a field that can group; none when nothing is chosen', () => {
    const note = f('note', 'text');
    expect(tableGroupField([status, note], { groupBy: 'status' })?.id).toBe('status');
    expect(tableGroupField([status, note], { groupBy: 'note' })).toBeUndefined();
    expect(tableGroupField([status, note], { groupBy: null })).toBeUndefined();
  });
});

describe('editViews', () => {
  test('an edit lands on the latest saved views, so a tab someone else just added stays', () => {
    const a = { ...defaultView(), id: 'a', name: 'All' };
    const b = { ...defaultView('board'), id: 'b', name: 'Board' };
    const latest = JSON.stringify([a, b]);
    const renamed = { ...a, name: 'Everything' };
    expect(parseViews(editViews(latest, replaceView(renamed)))).toEqual([renamed, b]);
    // A view someone else removed isn't brought back by an edit to it.
    expect(parseViews(editViews(JSON.stringify([b]), replaceView(renamed)))).toEqual([b]);
  });
});

describe('calendarWeeks', () => {
  test('Monday-first weeks covering the month', () => {
    const weeks = calendarWeeks('2026-10');
    expect(weeks[0]![0]).toBe('2026-09-28');
    expect(weeks.at(-1)!.at(-1)).toBe('2026-11-01');
    expect(weeks.every((w) => w.length === 7)).toBe(true);
  });
});

describe('dates on the timeline and calendar', () => {
  test('moving keeps the length; resizing never ends before the start', () => {
    expect(moveDate({ start: '2026-11-02', end: '2026-11-06' }, 3)).toEqual({ start: '2026-11-05', end: '2026-11-09' });
    expect(moveDate({ start: '2026-11-02' }, -2)).toEqual({ start: '2026-10-31' });
    expect(resizeEnd({ start: '2026-11-02' }, 2)).toEqual({ start: '2026-11-02', end: '2026-11-04' });
    expect(resizeEnd({ start: '2026-11-02', end: '2026-11-04' }, -5)).toEqual({ start: '2026-11-02' });
  });
  test('a bar sits at its start and spans its days', () => {
    const days = timelineDays('2026-11-01', 'week');
    expect(days).toHaveLength(14);
    expect(timelineBar({ start: '2026-11-03', end: '2026-11-04' }, '2026-11-01', 40)).toEqual({ left: 80, width: 80 });
    expect(timelineBar({ start: '2026-11-03' }, '2026-11-01', 40)).toEqual({ left: 80, width: 40 });
  });
});

describe('visibleFields', () => {
  test('every field when the view lists none; otherwise the listed ones in order, skipping removed ones', () => {
    const defs = [status, owner, done];
    expect(visibleFields(defs, null).map((d) => d.id)).toEqual(['status', 'owner', 'done']);
    expect(visibleFields(defs, ['done', 'gone', 'status']).map((d) => d.id)).toEqual(['done', 'status']);
  });
});
