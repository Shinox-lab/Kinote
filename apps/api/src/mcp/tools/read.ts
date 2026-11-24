import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { chunks, spaces, versions, withTenantTx, type DocumentRow } from '@kinote/db';
import { blockMarkdown, blockText, pageFieldEntries, readLiveBlocks } from '@kinote/core';
import { documentName, flattenBlocks, type BlockLike } from '@kinote/shared';
import { contentBlock, decodeCursor, encodeCursor, idMatches as sameId, MAX_RESULT_TOKENS, pageLink, shortId } from '../format.js';
import { resolvePageRef, ToolError } from '../refs.js';
import { defineTool, type ToolContext } from '../tool.js';

type Level = 'outline' | 'section' | 'full';
interface ReadCursor {
  p: string;
  l: Level | 'file';
  s?: string;
  i: number;
  /** Characters of unit `i` already returned, when one unit was longer than a result. */
  o?: number;
}

const BAD_CURSOR = 'This cursor belongs to another read. Start again without a cursor.';
const OUTLINE_HINT = 'Read level "outline" to find section IDs.';
/** Room kept for the content tags, the cursor line and escaping. */
const RESERVE_CHARS = 400;

const wordCount = (text: string) => text.split(/\s+/).filter(Boolean).length;
const blockWords = (block: BlockLike) => wordCount(flattenBlocks([block]).map((b) => b.text).join(' '));
const headingLevel = (block: BlockLike): number | null =>
  block.type === 'heading' ? Number((block.props as { level?: unknown } | undefined)?.level ?? 1) || 1 : null;

/** The index after the section that starts at `start`: the next heading of the same or a higher level. */
function sectionEnd(blocks: BlockLike[], start: number): number {
  const level = headingLevel(blocks[start]!)!;
  let end = start + 1;
  while (end < blocks.length) {
    const l = headingLevel(blocks[end]!);
    if (l !== null && l <= level) break;
    end++;
  }
  return end;
}

/**
 * The server's own lines: `Page <id> · <space> · <status>` and the link. The title is the page's own text and
 * goes inside the content block (`# <title>`), with everything else the page says.
 */
async function header(ctx: ToolContext, doc: DocumentRow): Promise<string[]> {
  const { actor } = ctx;
  const { space, numbers } = await withTenantTx(actor.tenantId, async (tx) => {
    const [s] = await tx
      .select({ name: spaces.name })
      .from(spaces)
      .where(and(eq(spaces.tenantId, actor.tenantId), eq(spaces.id, doc.spaceId)));
    const ids = [doc.indexedVersionId, doc.latestVersionId].filter((v): v is string => v !== null);
    const rows = ids.length
      ? await tx
          .select({ id: versions.id, number: versions.number })
          .from(versions)
          .where(and(eq(versions.tenantId, actor.tenantId), inArray(versions.id, ids)))
      : [];
    return { space: s?.name ?? '', numbers: new Map(rows.map((r) => [r.id, r.number])) };
  });
  const indexed = doc.indexedVersionId ? numbers.get(doc.indexedVersionId) : undefined;
  const latest = doc.latestVersionId ? numbers.get(doc.latestVersionId) : undefined;
  const status =
    indexed === undefined
      ? 'not indexed yet'
      : latest === undefined || latest === indexed
        ? `indexed v${indexed}`
        : `live page ahead of the index (indexed v${indexed}, latest v${latest})`;
  const link = pageLink(ctx.agent, ctx.deps.publicUrl, doc.id, doc.kind);
  return [`Page ${shortId(doc.id)} · ${space} · ${status}`, ...(link ? [link] : [])];
}

/** The longest head of `text` within `max` characters, cut after a line break or a space when there is one. */
function headOf(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const at = Math.max(cut.lastIndexOf('\n'), cut.lastIndexOf(' '));
  return at > max / 2 ? cut.slice(0, at + 1) : cut;
}

/**
 * The header, then as many units as fit under MAX_RESULT_TOKENS inside one content block, then a cursor line
 * when anything is left. A unit longer than a whole result is returned in parts: the cursor then points inside
 * it (`o`, characters already returned) and the next call continues it, marked "(continued)".
 */
function paged(
  head: string[],
  title: string,
  docId: string,
  units: string[],
  start: number,
  offset: number,
  cursorAt: (next: number, offset?: number) => ReadCursor,
  fieldsLine: string | null = null
): string {
  const top = head.join('\n');
  const titleLine = `# ${title}${fieldsLine ? `\n${fieldsLine}` : ''}`;
  const budget = MAX_RESULT_TOKENS * 4 - top.length - titleLine.length - RESERVE_CHARS;
  const parts: string[] = [];
  let used = 0;
  let i = start;
  let o = offset;
  let next: ReadCursor | null = null;
  while (i < units.length) {
    const rest = o > 0 ? `(continued) ${units[i]!.slice(o)}` : units[i]!;
    if (used + rest.length + 2 <= budget) {
      parts.push(rest);
      used += rest.length + 2;
      i++;
      o = 0;
      continue;
    }
    if (parts.length === 0) {
      // One unit is bigger than a whole result: return its head and point the cursor inside it.
      const prefix = o > 0 ? '(continued) ' : '';
      const piece = headOf(units[i]!.slice(o), budget - prefix.length - 2);
      parts.push(prefix + piece);
      next = cursorAt(i, o + piece.length);
    } else {
      next = o > 0 ? cursorAt(i, o) : cursorAt(i);
    }
    break;
  }
  const body = parts.length > 0 ? parts.join('\n\n') : '(This page is empty.)';
  const more = next ? `\nMore: call kinote_read with cursor "${encodeCursor(next)}".` : '';
  return `${top}\n${contentBlock(shortId(docId), `${titleLine}\n\n${body}`)}${more}`;
}

async function readFile(ctx: ToolContext, doc: DocumentRow, start: number, offset: number): Promise<string> {
  const head = await header(ctx, doc);
  if (!doc.indexedVersionId) return `${head.join('\n')}\nThis file has no extracted text yet. Try again after it is indexed.`;
  const rows = await withTenantTx(ctx.actor.tenantId, (tx) =>
    tx
      .select({ text: chunks.text })
      .from(chunks)
      .where(and(eq(chunks.tenantId, ctx.actor.tenantId), eq(chunks.versionId, doc.indexedVersionId!)))
      .orderBy(sql`${chunks.pageFrom} NULLS FIRST`, asc(chunks.ordinal))
  );
  return paged(head, doc.title, doc.id, rows.map((r) => r.text), start, offset, (i, o) => ({ p: doc.id, l: 'file', i, ...(o ? { o } : {}) }));
}

async function liveBlocksOf(ctx: ToolContext, doc: DocumentRow): Promise<{ title: string; blocks: BlockLike[]; fields: unknown }> {
  const live = await withTenantTx(ctx.actor.tenantId, (tx) => readLiveBlocks(tx, ctx.actor.tenantId, doc.id));
  if (live) return { title: live.title || doc.title, blocks: live.blocks, fields: live.fields };
  if (!doc.latestVersionId) return { title: doc.title, blocks: [], fields: null };
  const [v] = await withTenantTx(ctx.actor.tenantId, (tx) =>
    tx
      .select({ title: versions.title, blocks: versions.blocks, fields: versions.fields })
      .from(versions)
      .where(and(eq(versions.tenantId, ctx.actor.tenantId), eq(versions.id, doc.latestVersionId!)))
  );
  return { title: v?.title ?? doc.title, blocks: Array.isArray(v?.blocks) ? (v!.blocks as BlockLike[]) : [], fields: v?.fields ?? null };
}

/** A collection row's field values in one line (`Fields: Status: Done · Owner: Jane`); null for any other page. */
async function fieldsLineOf(ctx: ToolContext, doc: DocumentRow, fields: unknown): Promise<string | null> {
  const entries = await withTenantTx(ctx.actor.tenantId, (tx) => pageFieldEntries(tx, ctx.actor.tenantId, doc.id, fields));
  return entries.length > 0 ? `Fields: ${entries.map((e) => e.text).join(' · ')}` : null;
}

function outline(head: string[], title: string, docId: string, blocks: BlockLike[], fieldsLine: string | null): string {
  const lines = [`# ${title}`, ...(fieldsLine ? [fieldsLine] : [])];
  const firstHeading = blocks.findIndex((b) => headingLevel(b) !== null);
  const introEnd = firstHeading === -1 ? blocks.length : firstHeading;
  if (introEnd > 0) lines.push(`Intro: ${blocks.slice(0, introEnd).reduce((n, b) => n + blockWords(b), 0)} words`);
  blocks.forEach((b, i) => {
    const level = headingLevel(b);
    if (level === null) return;
    const words = blocks.slice(i + 1, sectionEnd(blocks, i)).reduce((n, x) => n + blockWords(x), 0);
    lines.push(`${'#'.repeat(level)} ${blockText(b).trim()}  [${shortId(b.id)}] ${words} words`);
  });
  if (blocks.length === 0) lines.push('(This page is empty.)');
  return `${head.join('\n')}\n${contentBlock(shortId(docId), lines.join('\n'))}`;
}

export const readTool = defineTool({
  name: 'kinote_read',
  annotations: { title: 'Read a page', readOnlyHint: true, openWorldHint: false },
  scope: 'read',
  limit: 'search',
  description:
    'Read a page. Start with level "outline" (headings with their IDs and sizes), then read one section with level "section" and its section_id, or the whole page with "full". Long results end with a cursor.',
  input: {
    page_id: z.string().min(1).max(64),
    level: z.enum(['outline', 'section', 'full']).optional(),
    section_id: z.string().min(1).max(64).optional(),
    cursor: z.string().max(2000).optional(),
  },
  async run(args, ctx) {
    const { actor, deps } = ctx;
    const doc = await withTenantTx(actor.tenantId, (tx) => resolvePageRef(tx, actor, args.page_id));
    ctx.touch([doc.id]);

    let cursor: ReadCursor | null = null;
    if (args.cursor !== undefined) {
      cursor = decodeCursor<ReadCursor>(args.cursor);
      const fits =
        cursor !== null &&
        cursor.p === doc.id &&
        Number.isInteger(cursor.i) &&
        cursor.i >= 0 &&
        (cursor.o === undefined || (Number.isInteger(cursor.o) && cursor.o > 0)) &&
        (doc.kind === 'file' ? cursor.l === 'file' : cursor.l !== 'file' && (args.level === undefined || args.level === cursor.l));
      if (!fits) throw new ToolError(BAD_CURSOR);
    }
    if (doc.kind === 'file') return readFile(ctx, doc, cursor?.i ?? 0, cursor?.o ?? 0);

    const level: Level = (cursor?.l as Level | undefined) ?? args.level ?? 'outline';
    if (level !== 'outline' && deps.collab) {
      try {
        await deps.collab.flush(documentName(actor.tenantId, doc.id));
      } catch (err) {
        ctx.log.warn({ err, pageId: doc.id }, 'mcp read: collab flush failed; reading the stored state');
      }
    }
    const { title, blocks, fields } = await liveBlocksOf(ctx, doc);
    const head = await header(ctx, doc);
    const fieldsLine = await fieldsLineOf(ctx, doc, fields);
    if (level === 'outline') return outline(head, title, doc.id, blocks, fieldsLine);

    let from = 0;
    let to = blocks.length;
    let sectionId: string | undefined;
    if (level === 'section') {
      const ref = cursor?.s ?? args.section_id;
      if (ref === undefined) throw new ToolError(`Give section_id with level "section". ${OUTLINE_HINT}`);
      const start = blocks.findIndex((b) => headingLevel(b) !== null && sameId(b.id, ref));
      if (start === -1) {
        if (blocks.some((b) => sameId(b.id, ref))) throw new ToolError(`"${ref}" is not a heading. ${OUTLINE_HINT}`);
        throw new ToolError(`No section "${ref}" on this page. ${OUTLINE_HINT}`);
      }
      from = start;
      to = sectionEnd(blocks, start);
      sectionId = blocks[start]!.id;
    }
    const slice = blocks.slice(from, to);
    const units = await Promise.all(slice.map(async (b) => `[${shortId(b.id)}] ${await blockMarkdown(b)}`));
    return paged(head, title, doc.id, units, cursor?.i ?? 0, cursor?.o ?? 0, (i, o) => ({
      p: doc.id,
      l: level,
      ...(sectionId ? { s: sectionId } : {}),
      i,
      ...(o ? { o } : {}),
    }), fieldsLine);
  },
});
