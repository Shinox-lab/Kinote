import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { documents, spaces, type DbTransaction, type DocumentRow } from '@kinote/db';
import { AppError } from '@kinote/contracts';
import { getReadableSpaceIds, requireDocumentRole, type Actor } from '@kinote/core';

/** A refusal whose message is the text the agent sees: what went wrong and what to do next. */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolError';
  }
}

const FULL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Hex digits, optionally with the UUID's dashes, at least 8 digits. */
const PREFIX = /^[0-9a-f-]+$/;

const pageNotFound = (ref: string) =>
  `No page "${ref}" that this agent can read. Use kinote_search or kinote_browse to find it.`;

/**
 * The live document an agent names by a full id or a prefix of 8 or more hex characters (dashes optional).
 * Only documents it can read count: in its readable spaces, not archived, and passing the Inbox rule. A page
 * that exists but is not readable gives exactly the same text as one that does not exist.
 */
export async function resolvePageRef(tx: DbTransaction, actor: Actor, rawRef: string): Promise<DocumentRow> {
  const ref = rawRef.trim();
  const norm = ref.toLowerCase();
  const hex = norm.replaceAll('-', '');
  const isFull = FULL_UUID.test(norm);
  if (!isFull && (!PREFIX.test(norm) || hex.length < 8 || hex.length > 32)) throw new ToolError(pageNotFound(ref));

  const { readableSpaceIds } = await getReadableSpaceIds(tx, actor);
  if (readableSpaceIds.length === 0) throw new ToolError(pageNotFound(ref));
  const rows = await tx
    .select()
    .from(documents)
    .where(
      and(
        eq(documents.tenantId, actor.tenantId),
        inArray(documents.spaceId, readableSpaceIds),
        isNull(documents.archivedAt),
        isFull ? eq(documents.id, norm) : sql`replace(${documents.id}::text, '-', '') LIKE ${hex + '%'}`
      )
    )
    .orderBy(documents.title, documents.id)
    .limit(20);

  const readable: DocumentRow[] = [];
  for (const doc of rows) {
    try {
      await requireDocumentRole(tx, actor, doc, 'viewer');
      readable.push(doc);
    } catch (err) {
      if (!(err instanceof AppError)) throw err;
    }
  }
  if (readable.length === 0) throw new ToolError(pageNotFound(ref));
  if (readable.length > 1) {
    const names = readable.map((d) => `${d.title} (${d.id.replaceAll('-', '').slice(0, 12)})`).join(', ');
    throw new ToolError(`"${ref}" matches several pages: ${names}. Use more characters.`);
  }
  return readable[0]!;
}

/** The readable spaces an agent may name, the Inbox left out, by name. */
export async function namedSpaces(tx: DbTransaction, actor: Actor): Promise<Array<{ id: string; name: string }>> {
  const { readableSpaceIds, inboxSpaceId } = await getReadableSpaceIds(tx, actor);
  const ids = readableSpaceIds.filter((id) => id !== inboxSpaceId);
  if (ids.length === 0) return [];
  return tx
    .select({ id: spaces.id, name: spaces.name })
    .from(spaces)
    .where(and(eq(spaces.tenantId, actor.tenantId), inArray(spaces.id, ids)))
    .orderBy(spaces.name);
}

/** A readable space (not the Inbox) named by its name (any case) or an id prefix. */
export async function resolveSpaceRef(tx: DbTransaction, actor: Actor, rawRef: string): Promise<{ id: string; name: string }> {
  const ref = rawRef.trim();
  const all = await namedSpaces(tx, actor);
  const lower = ref.toLowerCase();
  const byName = all.find((s) => s.name.toLowerCase() === lower);
  if (byName) return byName;
  const hex = lower.replaceAll('-', '');
  if (PREFIX.test(lower) && hex.length >= 8) {
    const byId = all.filter((s) => s.id.replaceAll('-', '').startsWith(hex));
    if (byId.length === 1) return byId[0]!;
  }
  throw new ToolError(`No space "${ref}". Spaces you can read: ${all.map((s) => s.name).join(', ') || 'none'}.`);
}
