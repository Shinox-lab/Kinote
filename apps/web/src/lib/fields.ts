import {
  CHOICE_COLORS,
  fieldValueFits,
  formatFieldValue,
  type Choice,
  type FieldDef,
  type FieldNames,
} from '@living-wiki/contracts';

/**
 * A field value as a person reads it on the page: dates in words only (the
 * index also carries the ISO day), everything else as the index prints it.
 * Null when the value doesn't fit the field (shown as empty).
 */
export function fieldDisplay(def: FieldDef, value: unknown, names: FieldNames): string | null {
  const text = formatFieldValue(def, value, names);
  if (text === null) return null;
  if (def.type === 'date') return /\((.*)\)$/.exec(text)?.[1] ?? text;
  return text;
}

/** How many fields have no value that fits: the count behind "N empty fields". */
export function emptyFieldCount(defs: FieldDef[], values: Record<string, unknown>): number {
  return defs.filter((d) => !fieldValueFits(d, values[d.id])).length;
}

/** The first choice colour not used yet (cycling once all are). */
export function nextChoiceColor(choices: Choice[]): Choice['color'] {
  const used = new Set(choices.map((c) => c.color));
  return CHOICE_COLORS.find((c) => !used.has(c)) ?? CHOICE_COLORS[choices.length % CHOICE_COLORS.length]!;
}

/** A new choice's id: random, short, unique within the field. */
export function newChoiceId(): string {
  return crypto.randomUUID().slice(0, 8);
}

/** The confirmation before a field (or a choice) is removed. */
export function removalWarning(name: string, pages: number): string {
  if (pages === 0) return `${name} will be removed. No page has a value for it yet.`;
  return `${name} will be removed from ${pages} ${pages === 1 ? 'page' : 'pages'}.`;
}

export const FIELD_TYPE_LABELS: Record<FieldDef['type'], string> = {
  text: 'Text',
  number: 'Number',
  date: 'Date',
  select: 'Select',
  multi_select: 'Multi-select',
  person: 'Person',
  checkbox: 'Checkbox',
  page: 'Page',
};

/**
 * Classes of a choice's colour chip: theme tokens (`--choice-<colour>-bg/-fg`
 * in index.css), so light and dark both work. Written out in full so
 * Tailwind sees every class.
 */
export const CHOICE_CLASSES: Record<Choice['color'], string> = {
  gray: 'bg-[var(--choice-gray-bg)] text-[var(--choice-gray-fg)]',
  brown: 'bg-[var(--choice-brown-bg)] text-[var(--choice-brown-fg)]',
  orange: 'bg-[var(--choice-orange-bg)] text-[var(--choice-orange-fg)]',
  yellow: 'bg-[var(--choice-yellow-bg)] text-[var(--choice-yellow-fg)]',
  green: 'bg-[var(--choice-green-bg)] text-[var(--choice-green-fg)]',
  blue: 'bg-[var(--choice-blue-bg)] text-[var(--choice-blue-fg)]',
  purple: 'bg-[var(--choice-purple-bg)] text-[var(--choice-purple-fg)]',
  pink: 'bg-[var(--choice-pink-bg)] text-[var(--choice-pink-fg)]',
  red: 'bg-[var(--choice-red-bg)] text-[var(--choice-red-fg)]',
};
