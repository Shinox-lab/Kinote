import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { documents, memberships, users, type DbTransaction } from '@kinote/db';
import { fieldValueFits, type FieldDef } from '@kinote/contracts';

export type ResolvedFieldValue = { ok: true; value: unknown } | { ok: false };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHECKBOX_WORDS: Record<string, boolean> = { yes: true, true: true, checked: true, no: false, false: false, unchecked: false };

const fold = (s: string) => s.trim().toLowerCase();
const strings = (raw: unknown): string[] | null =>
  typeof raw === 'string' ? [raw] : Array.isArray(raw) && raw.every((s) => typeof s === 'string') ? (raw as string[]) : null;
const unique = <T>(list: T[]): T[] => [...new Set(list)];

function number(raw: unknown): number | undefined {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : undefined;
  if (typeof raw !== 'string') return undefined;
  const s = raw.trim().replace(/,/g, '').replace(/^[$€£¥]/, '').replace(/%$/, '');
  if (!/^-?\d+(\.\d+)?$/.test(s)) return undefined;
  return Number(s);
}

function date(raw: unknown): unknown {
  if (typeof raw === 'string') return { start: raw.trim() };
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const { start, end } = raw as { start?: unknown; end?: unknown };
    return end === undefined || end === null ? { start } : { start, end };
  }
  return undefined;
}

/** Choice ids for names or ids; null when any one is not a choice (choices are never created). */
function choices(def: FieldDef, names: string[]): string[] | null {
  const list = def.options.choices ?? [];
  const ids: string[] = [];
  for (const name of names) {
    const hit = list.find((c) => c.id === name) ?? list.find((c) => fold(c.name) === fold(name));
    if (!hit) return null;
    ids.push(hit.id);
  }
  return unique(ids);
}

/** Member user ids for names (unique within the tenant, case-insensitive) or member ids. */
async function people(tx: DbTransaction, tenantId: string, names: string[]): Promise<string[] | null> {
  const members = await tx
    .select({ id: users.id, name: users.name })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(eq(memberships.tenantId, tenantId));
  const ids: string[] = [];
  for (const name of names) {
    const byId = UUID_RE.test(name.trim()) ? members.find((m) => m.id === name.trim().toLowerCase()) : undefined;
    const byName = members.filter((m) => fold(m.name) === fold(name));
    const hit = byId ?? (byName.length === 1 ? byName[0] : undefined);
    if (!hit) return null;
    ids.push(hit.id);
  }
  return unique(ids);
}

/** Live page ids of `spaceId` for titles (unique there, case-insensitive) or such ids. */
async function pageIds(tx: DbTransaction, tenantId: string, spaceId: string, names: string[]): Promise<string[] | null> {
  const ids = names.map((n) => n.trim()).filter((n) => UUID_RE.test(n)).map((n) => n.toLowerCase());
  const titles = names.map(fold).filter((n) => !UUID_RE.test(n));
  const live = and(eq(documents.tenantId, tenantId), eq(documents.spaceId, spaceId), eq(documents.kind, 'page'), isNull(documents.archivedAt));
  const rows =
    ids.length === 0 && titles.length === 0
      ? []
      : await tx
          .select({ id: documents.id, title: documents.title })
          .from(documents)
          .where(
            and(
              live,
              sql`(${ids.length > 0 ? inArray(documents.id, ids) : sql`false`} or ${
                titles.length > 0 ? inArray(sql`lower(trim(${documents.title}))`, titles) : sql`false`
              })`
            )
          );
  const out: string[] = [];
  for (const name of names) {
    const n = name.trim();
    const byId = UUID_RE.test(n) ? rows.find((r) => r.id === n.toLowerCase()) : undefined;
    const byTitle = rows.filter((r) => fold(r.title) === fold(n));
    const hit = byId ?? (byTitle.length === 1 ? byTitle[0] : undefined);
    if (!hit) return null;
    out.push(hit.id);
  }
  return unique(out);
}

/** The value to check, `null` for a clear, `undefined` when `raw` doesn't resolve. */
async function candidate(tx: DbTransaction, tenantId: string, def: FieldDef, raw: unknown, spaceId: string): Promise<unknown> {
  switch (def.type) {
    case 'text':
      return typeof raw === 'string' ? raw.trim() : undefined;
    case 'number':
      return number(raw);
    case 'date':
      return date(raw);
    case 'select':
      return typeof raw === 'string' ? choices(def, [raw])?.[0] : undefined;
    case 'multi_select': {
      const list = strings(raw);
      if (!list) return undefined;
      if (list.length === 0) return null;
      return choices(def, list) ?? undefined;
    }
    case 'checkbox':
      return typeof raw === 'boolean' ? raw : typeof raw === 'string' ? CHECKBOX_WORDS[fold(raw)] : undefined;
    case 'person': {
      const list = strings(raw);
      if (!list) return undefined;
      if (list.length === 0) return null;
      return (await people(tx, tenantId, list)) ?? undefined;
    }
    case 'page': {
      const list = strings(raw);
      if (!list) return undefined;
      if (list.length === 0) return null;
      return (await pageIds(tx, tenantId, spaceId, list)) ?? undefined;
    }
  }
}

/**
 * The stored value for a value the routing model planned for `def`: choice,
 * member and page names become ids, `YYYY-MM-DD` becomes a date. `null` (or
 * an empty list) clears the field. Anything that doesn't resolve, including
 * a choice name that isn't one of the field's choices, is `{ ok: false }`;
 * a resolved value always passes `fieldValueFits`.
 */
export async function resolveFieldValue(
  tx: DbTransaction,
  tenantId: string,
  def: FieldDef,
  raw: unknown,
  spaceId: string
): Promise<ResolvedFieldValue> {
  if (raw === null) return { ok: true, value: null };
  const value = await candidate(tx, tenantId, def, raw, spaceId);
  if (value === null) return { ok: true, value: null };
  return fieldValueFits(def, value) ? { ok: true, value } : { ok: false };
}
