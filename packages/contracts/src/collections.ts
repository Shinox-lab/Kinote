import { z } from 'zod';

/**
 * Page collections: a page whose direct sub-pages (rows) share typed fields.
 * Definitions live in Postgres; a row's values live in the `fields` Y.Map of
 * its page document, keyed by field id. Values are only ever read through
 * `validFields`: whatever doesn't fit its field's type (or names a field that
 * no longer exists) is ignored, never an error.
 */

export const FIELD_TYPES = ['text', 'number', 'date', 'select', 'multi_select', 'person', 'checkbox', 'page'] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

/** The Y.Map of a page document that holds its field values. */
export const FIELDS_MAP = 'fields';
/** `block_activity` and diff entries name a field as `field:<fieldId>`. */
export const FIELD_BLOCK_PREFIX = 'field:';
export const MAX_FIELDS = 50;
export const FIELD_NAME_MAX = 100;

export const NUMBER_FORMATS = ['plain', 'decimal', 'percent', 'currency'] as const;
export const CHOICE_COLORS = ['gray', 'brown', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'red'] as const;

export const ChoiceSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().trim().min(1).max(FIELD_NAME_MAX),
  color: z.enum(CHOICE_COLORS),
});
export type Choice = z.infer<typeof ChoiceSchema>;

export const FieldOptionsSchema = z
  .object({
    format: z.enum(NUMBER_FORMATS).optional(),
    code: z.string().regex(/^[A-Z]{3}$/).optional(),
    choices: z.array(ChoiceSchema).max(200).optional(),
  })
  .strict();
export type FieldOptions = z.infer<typeof FieldOptionsSchema>;

export const FieldDefSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(FIELD_TYPES),
  options: FieldOptionsSchema,
  position: z.string(),
});
export type FieldDef = z.infer<typeof FieldDefSchema>;

export const CollectionSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  fields: z.array(FieldDefSchema),
});
export type Collection = z.infer<typeof CollectionSchema>;

/** On page details: the page's own collection (it is one), and the collection it is a row of. */
export const PageCollectionInfoSchema = z.object({
  collection: CollectionSchema.nullable(),
  rowOf: CollectionSchema.nullable(),
});
export type PageCollectionInfo = z.infer<typeof PageCollectionInfoSchema>;

const FieldNameSchema = z.string().trim().min(1).max(FIELD_NAME_MAX);

export const CreateFieldRequestSchema = z.object({
  name: FieldNameSchema,
  type: z.enum(FIELD_TYPES),
  options: FieldOptionsSchema.optional(),
});
export const UpdateFieldRequestSchema = z
  .object({
    name: FieldNameSchema.optional(),
    options: FieldOptionsSchema.optional(),
    /** Put the field after this one; null puts it first. */
    after: z.string().uuid().nullable().optional(),
  })
  .refine((v) => v.name !== undefined || v.options !== undefined || v.after !== undefined, 'Nothing to change.');

/** `{ [fieldId]: value }`; null clears the field. */
export const SetFieldsRequestSchema = z.record(z.string().uuid(), z.unknown());
export const PageFieldsSchema = z.object({ fields: z.record(z.string(), z.unknown()) });
export const FieldUsageSchema = z.object({ pages: z.number().int() });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function isDay(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const m = DATE_RE.exec(value);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!));
  return d.toISOString().slice(0, 10) === value;
}

function distinctStrings(value: unknown, each: (s: string) => boolean): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((s) => typeof s === 'string' && each(s)) &&
    new Set(value).size === value.length
  );
}

function choiceIds(def: FieldDef): Set<string> {
  return new Set((def.options.choices ?? []).map((c) => c.id));
}

/** Whether `value` is a non-empty value of `def`'s type. Empty is the field being absent, so empty never fits. */
export function fieldValueFits(def: FieldDef, value: unknown): boolean {
  switch (def.type) {
    case 'text':
      return typeof value === 'string' && value.trim() !== '' && value.length <= 10_000;
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'date': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
      const { start, end, ...rest } = value as { start?: unknown; end?: unknown };
      if (Object.keys(rest).length > 0 || !isDay(start)) return false;
      return end === undefined || (isDay(end) && end >= start);
    }
    case 'select':
      return typeof value === 'string' && choiceIds(def).has(value);
    case 'multi_select': {
      const ids = choiceIds(def);
      return distinctStrings(value, (s) => ids.has(s));
    }
    case 'person':
    case 'page':
      return distinctStrings(value, (s) => UUID_RE.test(s));
    case 'checkbox':
      return typeof value === 'boolean';
  }
}

/** The values of defined fields that fit their type; everything else is left out. */
export function validFields(defs: FieldDef[], raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const def of defs) {
    if (Object.prototype.hasOwnProperty.call(raw, def.id) && fieldValueFits(def, raw[def.id])) out[def.id] = raw[def.id];
  }
  return out;
}

/** Display names for person and page values: members by user id, readable live pages by id. */
export interface FieldNames {
  users: Map<string, string>;
  pages: Map<string, string>;
}

const DAY_MONTH_YEAR = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const parts = (day: string) => {
  const p = Object.fromEntries(DAY_MONTH_YEAR.formatToParts(new Date(`${day}T00:00:00Z`)).map((x) => [x.type, x.value]));
  return { day: p.day!, month: p.month!, year: p.year! };
};

function dateWords(start: string, end?: string): string {
  const a = parts(start);
  if (!end || end === start) return `${a.day} ${a.month} ${a.year}`;
  const b = parts(end);
  if (a.year === b.year && a.month === b.month) return `${a.day}–${b.day} ${b.month} ${b.year}`;
  if (a.year === b.year) return `${a.day} ${a.month} – ${b.day} ${b.month} ${b.year}`;
  return `${a.day} ${a.month} ${a.year} – ${b.day} ${b.month} ${b.year}`;
}

/** A value as one line of plain text, or null when nothing printable is left (an ill-typed value, a former member). */
export function formatFieldValue(def: FieldDef, value: unknown, names: FieldNames): string | null {
  if (!fieldValueFits(def, value)) return null;
  const choiceName = (id: string) => def.options.choices?.find((c) => c.id === id)?.name;
  const joined = (list: Array<string | undefined>) => {
    const kept = list.filter((s): s is string => !!s);
    return kept.length > 0 ? kept.join(', ') : null;
  };
  switch (def.type) {
    case 'text':
      return (value as string).replace(/\s+/g, ' ').trim();
    case 'number': {
      const n = value as number;
      switch (def.options.format ?? 'plain') {
        case 'decimal':
          return n.toFixed(2);
        case 'percent':
          return `${n}%`;
        case 'currency':
          return `${def.options.code ?? 'USD'} ${n.toFixed(2)}`;
        default:
          return String(n);
      }
    }
    case 'date': {
      const { start, end } = value as { start: string; end?: string };
      const iso = end && end !== start ? `${start} to ${end}` : start;
      return `${iso} (${dateWords(start, end)})`;
    }
    case 'select':
      return choiceName(value as string) ?? null;
    case 'multi_select':
      return joined((value as string[]).map(choiceName));
    case 'person':
      return joined((value as string[]).map((id) => names.users.get(id)));
    case 'page':
      return joined((value as string[]).map((id) => names.pages.get(id)));
    case 'checkbox':
      return value ? 'Yes' : 'No';
  }
}

/** `Field name: value` for every printable value, in field order: the header indexed with a row. */
export function fieldLines(defs: FieldDef[], raw: Record<string, unknown>, names: FieldNames): string[] {
  return fieldEntries(defs, raw, names).map((e) => e.text);
}

/** As `fieldLines`, with the field each line is for. */
export function fieldEntries(
  defs: FieldDef[],
  raw: Record<string, unknown>,
  names: FieldNames
): Array<{ fieldId: string; text: string }> {
  return [...defs]
    .sort((a, b) => (a.position < b.position ? -1 : a.position > b.position ? 1 : 0))
    .flatMap((def) => {
      if (!Object.prototype.hasOwnProperty.call(raw, def.id)) return [];
      const shown = formatFieldValue(def, raw[def.id], names);
      return shown === null ? [] : [{ fieldId: def.id, text: `${def.name}: ${shown}` }];
    });
}
