import { z } from 'zod';
import { fieldValueFits, type FieldDef } from './collections.js';

/**
 * Collection views (spec C6–C8): a `collectionView` block names a collection
 * and holds its views (tabs) as JSON in its props, so settings are co-edited
 * and versioned with the page that holds the block. Filters, sorts and
 * prefill are pure, shared by the API (which filters and sorts) and the web.
 */

/** A view block. `title` is the collection's title when the block was made (Markdown and the index read it). */
export const collectionViewConfig = {
  type: 'collectionView',
  propSchema: {
    collectionId: { default: '' },
    title: { default: '' },
    /** JSON array of views (see `ViewSchema`); read with `parseViews`. */
    views: { default: '' },
  },
  content: 'none',
} as const;

export const VIEW_LAYOUTS = ['table', 'board', 'calendar', 'timeline'] as const;
export type ViewLayout = (typeof VIEW_LAYOUTS)[number];

export const FILTER_OPS = [
  'contains',
  'not_contains',
  'is',
  'is_not',
  'is_empty',
  'eq',
  'ne',
  'lt',
  'gt',
  'before',
  'after',
  'this_week',
  'this_month',
  'next_month',
  'checked',
  'unchecked',
] as const;
export type FilterOp = (typeof FILTER_OPS)[number];

/** The operators each field type offers, in menu order. `title` is the row title (text). */
export const OPS_BY_TYPE: Record<FieldDef['type'] | 'title', FilterOp[]> = {
  title: ['contains', 'is', 'is_empty'],
  text: ['contains', 'is', 'is_empty'],
  number: ['eq', 'ne', 'lt', 'gt', 'is_empty'],
  date: ['is', 'before', 'after', 'this_week', 'this_month', 'next_month', 'is_empty'],
  select: ['is', 'is_not', 'is_empty'],
  multi_select: ['contains', 'not_contains', 'is_empty'],
  person: ['contains', 'not_contains', 'is_empty'],
  checkbox: ['checked', 'unchecked'],
  page: ['contains', 'is_empty'],
};

/** Ops that take no value. */
export const VALUELESS_OPS: FilterOp[] = ['is_empty', 'this_week', 'this_month', 'next_month', 'checked', 'unchecked'];

/** The row title's pseudo field id in filters and sorts. */
export const TITLE_FIELD = 'title';
/** A person filter's value meaning "whoever is looking". */
export const ME = 'me';

export const ViewFilterSchema = z.object({
  fieldId: z.string().min(1).max(64),
  op: z.enum(FILTER_OPS),
  value: z.unknown().optional(),
});
export type ViewFilter = z.infer<typeof ViewFilterSchema>;

export const ViewSortSchema = z.object({ fieldId: z.string().min(1).max(64), dir: z.enum(['asc', 'desc']) });
export type ViewSort = z.infer<typeof ViewSortSchema>;

export const ViewSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().max(100).default('Table'),
  layout: z.enum(VIEW_LAYOUTS),
  filters: z.array(ViewFilterSchema).max(20).default([]),
  sorts: z.array(ViewSortSchema).max(5).default([]),
  /** Board columns, or table groups: a select, person or checkbox field. */
  groupBy: z.string().nullable().default(null),
  /** Calendar and timeline: a date field. */
  dateField: z.string().nullable().default(null),
  /** Fields shown, in order; null shows every field (new ones included). */
  visible: z.array(z.string()).nullable().default(null),
  widths: z.record(z.string(), z.number().int().min(60).max(800)).default({}),
});
export type View = z.infer<typeof ViewSchema>;

const LAYOUT_NAMES: Record<ViewLayout, string> = { table: 'Table', board: 'Board', calendar: 'Calendar', timeline: 'Timeline' };

/** A fresh view; the first view of a new block is `defaultView()` (id `default`). */
export function defaultView(layout: ViewLayout = 'table', id = 'default'): View {
  return { id, name: LAYOUT_NAMES[layout], layout, filters: [], sorts: [], groupBy: null, dateField: null, visible: null, widths: {} };
}

/** A block's views; anything unreadable (hand-edited, an older shape) is one default table. */
export function parseViews(json: string): View[] {
  try {
    const parsed = z.array(ViewSchema).min(1).max(20).safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : [defaultView()];
  } catch {
    return [defaultView()];
  }
}

/** A row as views see it: its title and its values that fit their fields. */
export interface ViewRow {
  title: string;
  values: Record<string, unknown>;
}

export interface FilterContext {
  /** The viewer's user id (for `me`), or null. */
  me: string | null;
  /** Today as `YYYY-MM-DD` (UTC). */
  today: string;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const addDays = (day: string, n: number) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
/** Monday..Sunday around `day`. */
function weekOf(day: string): [string, string] {
  const dow = (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7;
  const start = addDays(day, -dow);
  return [start, addDays(start, 6)];
}
function monthOf(day: string, offset = 0): [string, string] {
  const d = new Date(`${day.slice(0, 7)}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + offset);
  const start = d.toISOString().slice(0, 10);
  d.setUTCMonth(d.getUTCMonth() + 1);
  d.setUTCDate(0);
  return [start, d.toISOString().slice(0, 10)];
}

/** Whether one filter holds; null when it can't be judged (removed field, wrong op, bad value) and so is ignored. */
function holds(defs: FieldDef[], row: ViewRow, filter: ViewFilter, ctx: FilterContext): boolean | null {
  const { op } = filter;
  let value = filter.value;
  if (filter.fieldId === TITLE_FIELD) {
    if (!OPS_BY_TYPE.title.includes(op)) return null;
    if (op === 'is_empty') return row.title.trim() === '';
    if (typeof value !== 'string') return null;
    const t = row.title.toLowerCase();
    return op === 'contains' ? t.includes(value.toLowerCase()) : t === value.toLowerCase();
  }
  const def = defs.find((d) => d.id === filter.fieldId);
  if (!def || !OPS_BY_TYPE[def.type].includes(op)) return null;
  const raw = row.values[def.id];
  const v = fieldValueFits(def, raw) ? raw : undefined;
  if (op === 'is_empty') return v === undefined;
  if (op === 'checked') return v === true;
  if (op === 'unchecked') return v !== true;
  if (def.type === 'person' && value === ME) value = ctx.me ?? undefined;

  switch (def.type) {
    case 'text': {
      if (typeof value !== 'string') return null;
      if (v === undefined) return false;
      const t = (v as string).toLowerCase();
      return op === 'contains' ? t.includes(value.toLowerCase()) : t === value.trim().toLowerCase();
    }
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return null;
      if (v === undefined) return op === 'ne';
      const n = v as number;
      return op === 'eq' ? n === value : op === 'ne' ? n !== value : op === 'lt' ? n < value : n > value;
    }
    case 'date': {
      let range: [string, string] | null = null;
      if (op === 'this_week') range = weekOf(ctx.today);
      else if (op === 'this_month') range = monthOf(ctx.today);
      else if (op === 'next_month') range = monthOf(ctx.today, 1);
      else if (typeof value !== 'string' || !DAY.test(value)) return null;
      if (v === undefined) return false;
      const { start, end = start } = v as { start: string; end?: string };
      if (range) return start <= range[1] && end >= range[0];
      const day = value as string;
      return op === 'is' ? start <= day && day <= end : op === 'before' ? start < day : end > day;
    }
    case 'select':
      if (typeof value !== 'string') return null;
      return op === 'is' ? v === value : v !== value;
    case 'multi_select':
    case 'person':
    case 'page': {
      if (typeof value !== 'string') return null;
      const has = Array.isArray(v) && (v as string[]).includes(value);
      return op === 'contains' ? has : !has;
    }
    case 'checkbox':
      return null;
  }
}

/** Whether the row passes every filter (AND); filters that can't be judged are ignored. */
export function rowMatches(defs: FieldDef[], row: ViewRow, filters: ViewFilter[], ctx: FilterContext): boolean {
  return filters.every((f) => holds(defs, row, f, ctx) !== false);
}

/** A sortable key of a value, or undefined for empty. */
function sortKey(def: FieldDef, value: unknown): string | number | undefined {
  if (!fieldValueFits(def, value)) return undefined;
  switch (def.type) {
    case 'number':
      return value as number;
    case 'date':
      return (value as { start: string }).start;
    case 'select':
      return (def.options.choices ?? []).findIndex((c) => c.id === value);
    case 'checkbox':
      return value ? 1 : 0;
    case 'text':
      return (value as string).toLowerCase();
    default:
      return (value as unknown[]).length;
  }
}

/** A comparator for `sorts` in order (empties last in either direction), then by title. */
export function compareRows<R extends ViewRow>(defs: FieldDef[], sorts: ViewSort[]): (a: R, b: R) => number {
  const byTitle = (a: R, b: R) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base', numeric: true });
  return (a, b) => {
    for (const s of sorts) {
      const sign = s.dir === 'desc' ? -1 : 1;
      if (s.fieldId === TITLE_FIELD) {
        const c = byTitle(a, b);
        if (c !== 0) return sign * c;
        continue;
      }
      const def = defs.find((d) => d.id === s.fieldId);
      if (!def) continue;
      const ka = sortKey(def, a.values[def.id]);
      const kb = sortKey(def, b.values[def.id]);
      if (ka === kb) continue;
      if (ka === undefined) return 1;
      if (kb === undefined) return -1;
      return sign * (ka < kb ? -1 : 1);
    }
    return byTitle(a, b);
  };
}

/** The values a new row gets from filters that pin one value, so it shows in the view it was added from. */
export function prefill(defs: FieldDef[], filters: ViewFilter[], me: string | null): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const filter of filters) {
    const def = defs.find((d) => d.id === filter.fieldId);
    if (!def) continue;
    let value = filter.value;
    if (def.type === 'person' && value === ME) value = me ?? undefined;
    let candidate: unknown;
    if (filter.op === 'checked' && def.type === 'checkbox') candidate = true;
    else if (filter.op === 'is' && def.type === 'select') candidate = value;
    else if (filter.op === 'is' && def.type === 'text') candidate = value;
    else if (filter.op === 'eq' && def.type === 'number') candidate = value;
    else if (filter.op === 'is' && def.type === 'date') candidate = { start: value };
    else if (filter.op === 'contains' && ['multi_select', 'person', 'page'].includes(def.type)) candidate = [value];
    if (candidate !== undefined && fieldValueFits(def, candidate)) out[def.id] = candidate;
  }
  return out;
}

/** The board columns (or table groups) a row falls in: one per value, `''` for none; a checkbox is `true`/`false`. */
export function groupKeysOf(def: FieldDef, value: unknown): string[] {
  const v = fieldValueFits(def, value) ? value : undefined;
  if (def.type === 'checkbox') return [v === true ? 'true' : 'false'];
  if (v === undefined) return [''];
  return Array.isArray(v) ? (v as string[]) : [String(v)];
}

/** Body of POST /api/v1/collections/:id/rows. */
export const CollectionRowsRequestSchema = z.object({
  filters: z.array(ViewFilterSchema).max(20).default([]),
  sorts: z.array(ViewSortSchema).max(5).default([]),
});
export const CollectionRowSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  icon: z.string().nullable(),
  values: z.record(z.string(), z.unknown()),
});
export type CollectionRow = z.infer<typeof CollectionRowSchema>;

/** The most rows one view loads. */
export const MAX_VIEW_ROWS = 1000;
