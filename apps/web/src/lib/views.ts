import { fieldValueFits, groupKeysOf, type CollectionRow, type FieldDef, type FieldNames, type View } from '@living-wiki/contracts';

/** A date field's value. */
export interface DateValue {
  start: string;
  end?: string;
}

const day = (s: string) => new Date(`${s}T00:00:00Z`);
export const addDays = (s: string, n: number) => {
  const d = day(s);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
export const daysBetween = (a: string, b: string) => Math.round((day(b).getTime() - day(a).getTime()) / 86_400_000);
export const todayIso = () => new Date().toISOString().slice(0, 10);

/** The fields a view shows, in its order: all of them when it lists none; removed ones are skipped. */
export function visibleFields(defs: FieldDef[], visible: string[] | null): FieldDef[] {
  if (visible === null) return defs;
  return visible.flatMap((id) => defs.filter((d) => d.id === id));
}

/** Fields a board (or a table) can group by, and fields a calendar or timeline can use. */
export const groupableFields = (defs: FieldDef[]) => defs.filter((d) => d.type === 'select' || d.type === 'person' || d.type === 'checkbox');
export const dateFields = (defs: FieldDef[]) => defs.filter((d) => d.type === 'date');

/** A board's grouping field: the chosen one, else the first that can group. */
export const viewGroupField = (defs: FieldDef[], view: Pick<View, 'groupBy'>) =>
  groupableFields(defs).find((d) => d.id === view.groupBy) ?? groupableFields(defs)[0];
/** A calendar's or timeline's date field: the chosen one, else the first date field. */
export const viewDateField = (defs: FieldDef[], view: Pick<View, 'dateField'>) =>
  dateFields(defs).find((d) => d.id === view.dateField) ?? dateFields(defs)[0];

export interface RowGroup {
  /** The column's value key (see `groupKeysOf`); '' is "No value". */
  key: string;
  label: string;
  rows: CollectionRow[];
}

/**
 * Rows by the value of `def`: a select's choices in their order, people as
 * they appear, Yes/No for a checkbox, then "No value". A row with several
 * people is in each of their columns.
 */
export function groupRows(rows: CollectionRow[], def: FieldDef, names: FieldNames): RowGroup[] {
  const groups = new Map<string, RowGroup>();
  const add = (key: string, label: string) => {
    if (!groups.has(key)) groups.set(key, { key, label, rows: [] });
  };
  if (def.type === 'select') for (const c of def.options.choices ?? []) add(c.id, c.name);
  if (def.type === 'checkbox') {
    add('true', 'Yes');
    add('false', 'No');
  }
  for (const row of rows) {
    for (const key of groupKeysOf(def, row.values[def.id])) {
      if (key !== '') add(key, def.type === 'person' ? (names.users.get(key) ?? 'Former member') : key);
    }
  }
  if (def.type !== 'checkbox') add('', 'No value');
  for (const row of rows) for (const key of groupKeysOf(def, row.values[def.id])) groups.get(key)?.rows.push(row);
  // "No value" goes last whatever order rows came in.
  const empty = groups.get('');
  groups.delete('');
  return [...groups.values(), ...(empty ? [empty] : [])];
}

/**
 * The value a card gets when moved from column `from` to `to` on a board
 * grouped by `def`: null clears the field, undefined means no change.
 */
export function boardMove(def: FieldDef, value: unknown, from: string, to: string): unknown {
  if (from === to) return undefined;
  if (def.type === 'checkbox') return to === 'true';
  if (def.type === 'select') return to === '' ? null : to;
  const current = fieldValueFits(def, value) ? (value as string[]) : [];
  const kept = current.filter((id) => id !== from && id !== to);
  const next = to === '' ? kept : [...kept, to];
  return next.length > 0 ? next : null;
}

/** The Monday-first weeks a month's calendar shows (`YYYY-MM`), each 7 days. */
export function calendarWeeks(month: string): string[][] {
  const first = `${month}-01`;
  const start = addDays(first, -((day(first).getUTCDay() + 6) % 7));
  const nextMonth = day(first);
  nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
  const last = addDays(nextMonth.toISOString().slice(0, 10), -1);
  const weeks: string[][] = [];
  for (let d = start; d <= last; d = addDays(d, 7)) weeks.push(Array.from({ length: 7 }, (_, i) => addDays(d, i)));
  return weeks;
}

/** A date moved by `days`, keeping its length. */
export function moveDate(value: DateValue, days: number): DateValue {
  return value.end ? { start: addDays(value.start, days), end: addDays(value.end, days) } : { start: addDays(value.start, days) };
}

/** A date whose end moved by `days`; an end on or before the start makes it a single day. */
export function resizeEnd(value: DateValue, days: number): DateValue {
  const end = addDays(value.end ?? value.start, days);
  return end > value.start ? { start: value.start, end } : { start: value.start };
}

export const TIMELINE_ZOOM = {
  week: { days: 14, px: 40 },
  month: { days: 42, px: 24 },
  quarter: { days: 91, px: 10 },
} as const;
export type TimelineZoom = keyof typeof TIMELINE_ZOOM;

/** The days a timeline shows from `start` at `zoom`. */
export function timelineDays(start: string, zoom: TimelineZoom): string[] {
  return Array.from({ length: TIMELINE_ZOOM[zoom].days }, (_, i) => addDays(start, i));
}

/** Where a bar sits on a timeline starting at `start`, `px` wide per day. */
export function timelineBar(value: DateValue, start: string, px: number): { left: number; width: number } {
  return { left: daysBetween(start, value.start) * px, width: (daysBetween(value.start, value.end ?? value.start) + 1) * px };
}
