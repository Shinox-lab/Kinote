import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { chunks, documents, sources, spaces, versions, withTenantTx, type DbTransaction, type DocumentRow } from '@kinote/db';
import {
  blockMarkdown,
  blockText,
  currentFileVersion,
  pageFieldEntries,
  readLiveBlocks,
  requireDocumentRole,
  type VersionRow,
} from '@kinote/core';
import { resolveActorNames } from '../../people.js';
import { editHintFor } from '../editHint.js';
import { documentName, flattenBlocks, type BlockLike } from '@kinote/shared';
import { contentBlock, decodeCursor, encodeCursor, idMatches as sameId, MAX_RESULT_TOKENS, pageLink, shortId } from '../format.js';
import { resolvePageRef, ToolError } from '../refs.js';
import { defineTool, type ToolContext } from '../tool.js';

type Level = 'outline' | 'section' | 'full' | 'info' | 'versions';
interface ReadCursor {
  p: string;
  l: Level | 'file';
  s?: string;
  i: number;
  /** Characters of unit `i` already returned, when one unit was longer than a result. */
  o?: number;
}

const BAD_CURSOR = 'This cursor belongs to another read. Start again without a cursor.';
const NO_SECTIONS = 'A file has no sections. Read level "full" for its text.';
const VERSIONS_PER_CALL = 20;
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

/** What the header and the info level say about a page or file, loaded once per read. */
interface ReadFacts {
  spaceName: string;
  spaceArchived: boolean;
  role: 'viewer' | 'editor';
  latest: VersionRow | null;
  indexedNumber: number | undefined;
  /** Files: the version a replace builds on (see `currentFileVersion`). */
  current: VersionRow | null;
  sourceName: string | null;
}

async function factsOf(ctx: ToolContext, doc: DocumentRow): Promise<ReadFacts> {
  const { actor } = ctx;
  return withTenantTx(actor.tenantId, async (tx) => {
    const access = await requireDocumentRole(tx, actor, doc, 'viewer');
    const canEdit = access.effectiveRole !== 'viewer' && !access.space.archivedAt && ctx.agent.scopes.includes('edit');
    const ids = [doc.indexedVersionId, doc.latestVersionId].filter((v): v is string => v !== null);
    const rows = ids.length
      ? await tx.select().from(versions).where(and(eq(versions.tenantId, actor.tenantId), inArray(versions.id, ids)))
      : [];
    const byId = new Map(rows.map((r) => [r.id, r]));
    let sourceName: string | null = null;
    if (doc.sourceId) {
      const [src] = await tx
        .select({ name: sources.name })
        .from(sources)
        .where(and(eq(sources.tenantId, actor.tenantId), eq(sources.id, doc.sourceId)));
      sourceName = src?.name ?? null;
    }
    return {
      spaceName: access.space.name,
      spaceArchived: access.space.archivedAt !== null,
      role: canEdit ? 'editor' : 'viewer',
      latest: doc.latestVersionId ? (byId.get(doc.latestVersionId) ?? null) : null,
      indexedNumber: doc.indexedVersionId ? byId.get(doc.indexedVersionId)?.number : undefined,
      current: doc.kind === 'file' ? await currentFileVersion(tx, actor.tenantId, doc.id) : null,
      sourceName,
    };
  });
}

/** A version's status in words a person would use. */
const STATUS_WORDS: Record<VersionRow['status'], string> = {
  extracting: 'being read',
  pending_review: 'waiting for review',
  indexing: 'being indexed',
  indexed: 'indexed',
  superseded: 'superseded',
  rejected: 'rejected',
  withdrawn: 'withdrawn',
  failed: 'failed',
  stored: 'stored (no text)',
};

/**
 * The server's own lines: `Page <id> · <space> · <status>`, the link, and how it changes (`Edit with: …`). The
 * title is the page's own text and goes inside the content block (`# <title>`), with everything else it says.
 */
function header(ctx: ToolContext, doc: DocumentRow, f: ReadFacts): string[] {
  const indexed = f.indexedNumber;
  const latest = f.latest?.number;
  const status =
    indexed === undefined
      ? 'not indexed yet'
      : latest === undefined || latest === indexed
        ? `indexed v${indexed}`
        : doc.kind === 'file'
          ? `indexed v${indexed}, latest v${latest} ${STATUS_WORDS[f.latest!.status]}`
          : `live page ahead of the index (indexed v${indexed}, latest v${latest})`;
  const link = pageLink(ctx.agent, ctx.deps.publicUrl, doc.id, doc.kind);
  return [
    `Page ${shortId(doc.id)} · ${f.spaceName} · ${status}`,
    ...(link ? [link] : []),
    editHintFor(doc, f.role, f.current, f.sourceName),
  ];
}

/** `48 KB`, `1.2 MB`, `310 B`. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
const when = (d: Date) => d.toISOString().slice(0, 16).replace('T', ' ');
const typeOf = (fileName: string | null) => (fileName?.includes('.') ? fileName.split('.').pop()!.toLowerCase() : 'file');

/** Display names for version authors: a person's name, `Agent "<name>"`, or a source's name. */
async function authorNames(tx: DbTransaction, tenantId: string, rows: Pick<VersionRow, 'createdByType' | 'createdBy'>[]) {
  const names = await resolveActorNames(tx, tenantId, rows.map((v) => ({ type: v.createdByType, id: v.createdBy })));
  return (v: Pick<VersionRow, 'createdByType' | 'createdBy'>) => {
    const name = names.get(`${v.createdByType}:${v.createdBy}`) ?? '';
    return v.createdByType === 'agent' ? `Agent "${name}"` : name;
  };
}

/** `Open › Plans › Q3`: the space and the titles of the pages above. */
async function locationOf(tx: DbTransaction, tenantId: string, doc: DocumentRow, spaceName: string): Promise<string> {
  const titles: string[] = [];
  let parentId = doc.parentId;
  for (let depth = 0; parentId && depth < 20; depth++) {
    const [parent] = await tx
      .select({ title: documents.title, parentId: documents.parentId })
      .from(documents)
      .where(and(eq(documents.tenantId, tenantId), eq(documents.id, parentId)));
    if (!parent) break;
    titles.unshift(parent.title);
    parentId = parent.parentId;
  }
  return [spaceName, ...titles].join(' › ');
}

/** Why a file has no readable text, from its latest version's status. */
function noTextReason(latest: VersionRow | null): string {
  switch (latest?.status) {
    case 'extracting':
    case 'indexing':
      return 'still being read';
    case 'pending_review':
      return 'waiting for review';
    case 'stored':
      return 'an image without words, audio or video';
    case 'failed':
      return 'Kinote could not read it';
    default:
      return 'none readable';
  }
}

async function readInfo(ctx: ToolContext, doc: DocumentRow, f: ReadFacts, page?: { blocks: BlockLike[]; fieldsLine: string | null }): Promise<string> {
  const { tenantId } = ctx.actor;
  const head = header(ctx, doc, f);
  const lines = await withTenantTx(tenantId, async (tx) => {
    const shown = doc.kind === 'file' ? (f.current ?? f.latest) : f.latest;
    const by = shown ? await authorNames(tx, tenantId, [shown]) : null;
    const versionLine = shown
      ? `Version: v${shown.number} (${shown.id === f.latest?.id ? (doc.kind === 'file' ? 'latest' : 'latest saved') : `latest v${f.latest?.number}`}) · ${STATUS_WORDS[shown.status]} · by ${by!(shown)}, ${when(shown.createdAt)}`
      : 'Version: none saved yet';
    const location = `Location: ${await locationOf(tx, tenantId, doc, f.spaceName)}`;
    if (doc.kind === 'file') {
      const file = shown;
      return [
        `Type: ${typeOf(file?.fileName ?? doc.title)} · ${formatSize(file?.sizeBytes ?? 0)} · ${file?.fileName ?? doc.title}`,
        versionLine,
        `Readable text: ${f.indexedNumber !== undefined ? `v${f.indexedNumber}` : `none, ${noTextReason(f.latest)}`}`,
        location,
      ];
    }
    const words = page!.blocks.reduce((n, b) => n + blockWords(b), 0);
    return [`# ${doc.title}`, 'Kind: page', ...(page!.fieldsLine ? [page!.fieldsLine] : []), `Words: ${words}`, versionLine, location];
  });
  return `${head.join('\n')}\n${contentBlock(shortId(doc.id), lines.join('\n'))}`;
}

async function readVersions(ctx: ToolContext, doc: DocumentRow, f: ReadFacts, start: number): Promise<string> {
  const { tenantId } = ctx.actor;
  const head = header(ctx, doc, f);
  const { lines, more } = await withTenantTx(tenantId, async (tx) => {
    const rows = await tx
      .select()
      .from(versions)
      .where(and(eq(versions.tenantId, tenantId), eq(versions.documentId, doc.id)))
      .orderBy(desc(versions.number))
      .offset(start)
      .limit(VERSIONS_PER_CALL + 1);
    const page = rows.slice(0, VERSIONS_PER_CALL);
    const by = await authorNames(tx, tenantId, page);
    return {
      more: rows.length > VERSIONS_PER_CALL,
      lines: page.map((v) =>
        [`v${v.number}`, STATUS_WORDS[v.status], by(v), when(v.createdAt), ...(v.sizeBytes !== null ? [formatSize(v.sizeBytes)] : [])].join(' · ')
      ),
    };
  });
  const body = lines.length > 0 ? lines.join('\n') : '(No versions yet.)';
  const next = more ? `\nMore: call kinote_read with cursor "${encodeCursor({ p: doc.id, l: 'versions', i: start + VERSIONS_PER_CALL } satisfies ReadCursor)}".` : '';
  return `${head.join('\n')}\n${contentBlock(shortId(doc.id), body)}${next}`;
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

/** No indexed text: what to tell the agent, from the latest version's status. */
function noTextMessage(latest: VersionRow | null): string {
  switch (latest?.status) {
    case 'extracting':
    case 'indexing':
      return 'Kinote is still reading this file. Try again in a minute.';
    case 'pending_review':
      return 'This version is waiting for review; its text is readable once a person approves it.';
    case 'stored':
      return 'This file has no text Kinote can read (an image without words, audio or video). kinote_download gets the file itself.';
    case 'failed':
      return `Kinote could not read this file: ${(latest.error ?? 'unknown error').replace(/\.$/, '')}. kinote_download gets the file itself.`;
    case 'rejected':
    case 'withdrawn':
      return `The latest version was ${latest.status}; no other version has readable text.`;
    default:
      return 'This file has no extracted text yet.';
  }
}

async function readFile(ctx: ToolContext, doc: DocumentRow, f: ReadFacts, start: number, offset: number): Promise<string> {
  const head = header(ctx, doc, f);
  if (!doc.indexedVersionId) return `${head.join('\n')}\n${noTextMessage(f.latest)}`;
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
    'Read a page or file. Start with level "outline" (headings with their IDs and sizes), then read one section with level "section" and its section_id, or the whole page with "full". Level "info" gives what it is, its size, its current version and how to change it; "versions" lists its versions, newest first. A file has no sections: with no level, or "full", it returns its extracted text; "outline" is the same as "info". Text extracted from a file can be incomplete for large files and its layout can change; don\'t rely on its structure. Long results end with a cursor.',
  input: {
    page_id: z.string().min(1).max(64),
    level: z.enum(['outline', 'section', 'full', 'info', 'versions']).optional(),
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
        (cursor.l === 'versions'
          ? args.level === 'versions'
          : args.level !== 'versions' &&
            (doc.kind === 'file' ? cursor.l === 'file' && (args.level === undefined || args.level === 'full') : cursor.l !== 'file' && (args.level === undefined || args.level === cursor.l)));
      if (!fits) throw new ToolError(BAD_CURSOR);
    }
    const facts = await factsOf(ctx, doc);
    if (args.level === 'versions') return readVersions(ctx, doc, facts, cursor?.i ?? 0);
    if (doc.kind === 'file') {
      if (args.level === 'section') throw new ToolError(NO_SECTIONS);
      if (args.level === 'info' || args.level === 'outline') return readInfo(ctx, doc, facts);
      return readFile(ctx, doc, facts, cursor?.i ?? 0, cursor?.o ?? 0);
    }

    const level: Level = (cursor?.l as Level | undefined) ?? args.level ?? 'outline';
    if (level !== 'outline' && deps.collab) {
      try {
        await deps.collab.flush(documentName(actor.tenantId, doc.id));
      } catch (err) {
        ctx.log.warn({ err, pageId: doc.id }, 'mcp read: collab flush failed; reading the stored state');
      }
    }
    const { title, blocks, fields } = await liveBlocksOf(ctx, doc);
    const head = header(ctx, doc, facts);
    const fieldsLine = await fieldsLineOf(ctx, doc, fields);
    if (level === 'info') return readInfo(ctx, { ...doc, title }, facts, { blocks, fieldsLine });
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
