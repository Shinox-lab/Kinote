import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { documents, pageCards, spaces, withTenantTx } from '@kinote/db';
import { AppError } from '@kinote/contracts';
import type { TreeNode } from '@kinote/contracts';
import { getSpaceArchived, getSpaceTree } from '../../routes/foundations.js';
import { dataBlock, MAX_RESULT_TOKENS, shortId } from '../format.js';
import { namedSpaces, resolvePageRef, resolveSpaceRef } from '../refs.js';
import { defineTool, type ToolContext } from '../tool.js';

const CHILDREN_SHOWN = 20;
const SUMMARY_CHARS = 120;
const CUT_NOTE = 'Map cut at 6,000 tokens. Call kinote_browse with space or under to see more.';

/** A card summary as one map line: its first sentence, at most 120 characters. */
function oneLine(summary: string): string {
  const flat = summary.replace(/\s+/g, ' ').trim();
  const first = /^(.+?[.!?])(\s|$)/.exec(flat)?.[1] ?? flat;
  return first.length <= SUMMARY_CHARS ? first : `${first.slice(0, SUMMARY_CHARS - 1).trimEnd()}…`;
}

interface Section {
  heading: string;
  /** The nodes printed at indent 0 (a space's top level, or the children of `under`). */
  roots: TreeNode[];
  /** Who the roots hang under, for the "… n more under" line. */
  rootLabel: string;
  children: Map<string | null, TreeNode[]>;
}

function childrenMap(nodes: TreeNode[]): Map<string | null, TreeNode[]> {
  const ids = new Set(nodes.map((n) => n.id));
  const map = new Map<string | null, TreeNode[]>();
  for (const n of nodes) {
    // A page whose parent is not in the live tree (archived parent) shows at the top level.
    const parent = n.parentId !== null && ids.has(n.parentId) ? n.parentId : null;
    map.set(parent, [...(map.get(parent) ?? []), n]);
  }
  return map;
}

function descendants(children: Map<string | null, TreeNode[]>, id: string): number {
  return (children.get(id) ?? []).reduce((n, c) => n + 1 + descendants(children, c.id), 0);
}

/** Lines for one section, and the ids of the pages it shows. */
function render(section: Section, depth: number, summaries: Map<string, string>): string[] {
  const lines: string[] = [section.heading];
  if (section.roots.length === 0) lines.push('(no pages yet)');
  const walk = (nodes: TreeNode[], level: number, parentLabel: string) => {
    const indent = '  '.repeat(level - 1);
    for (const node of nodes.slice(0, CHILDREN_SHOWN)) {
      const summary = summaries.get(node.id);
      const below = level === depth ? descendants(section.children, node.id) : 0;
      lines.push(
        `${indent}- ${node.title} (${shortId(node.id)})${node.kind === 'file' ? ' [file]' : ''}${summary ? ` — ${summary}` : ''}${below > 0 ? ` (${below} below)` : ''}`
      );
      if (level < depth) walk(section.children.get(node.id) ?? [], level + 1, `${node.title} (${shortId(node.id)})`);
    }
    if (nodes.length > CHILDREN_SHOWN) lines.push(`${indent}… ${nodes.length - CHILDREN_SHOWN} more under ${parentLabel}`);
  };
  walk(section.roots, 1, section.rootLabel);
  return lines;
}

/** Node ids a section would print at this depth (for the one summary query). */
function shownIds(section: Section, depth: number): string[] {
  const out: string[] = [];
  const walk = (nodes: TreeNode[], level: number) => {
    for (const n of nodes.slice(0, CHILDREN_SHOWN)) {
      out.push(n.id);
      if (level < depth) walk(section.children.get(n.id) ?? [], level + 1);
    }
  };
  walk(section.roots, 1);
  return out;
}

async function sectionsFor(ctx: ToolContext, space: string | undefined, under: string | undefined): Promise<Section[]> {
  const { actor } = ctx;
  if (under !== undefined) {
    const { doc, spaceName } = await withTenantTx(actor.tenantId, async (tx) => {
      const d = await resolvePageRef(tx, actor, under);
      const [s] = await tx
        .select({ name: spaces.name })
        .from(spaces)
        .where(and(eq(spaces.tenantId, actor.tenantId), eq(spaces.id, d.spaceId)));
      return { doc: d, spaceName: s?.name ?? '' };
    });
    const tree = await getSpaceTree(actor, doc.spaceId);
    const children = childrenMap(tree.nodes);
    const label = `${doc.title} (${shortId(doc.id)})`;
    return [{ heading: `# ${spaceName} › ${label}`, roots: children.get(doc.id) ?? [], rootLabel: label, children }];
  }
  const chosen = await withTenantTx(actor.tenantId, async (tx) =>
    space !== undefined ? [await resolveSpaceRef(tx, actor, space)] : namedSpaces(tx, actor)
  );
  const out: Section[] = [];
  for (const s of chosen) {
    const tree = await getSpaceTree(actor, s.id);
    const children = childrenMap(tree.nodes);
    out.push({ heading: `# ${s.name}`, roots: children.get(null) ?? [], rootLabel: s.name, children });
  }
  return out;
}

/** The deleted (archived) pages of the chosen spaces, flat by title, with when each was deleted. */
async function archivedMap(ctx: ToolContext, space: string | undefined): Promise<string> {
  const { actor } = ctx;
  const chosen = await withTenantTx(actor.tenantId, async (tx) =>
    space !== undefined ? [await resolveSpaceRef(tx, actor, space)] : namedSpaces(tx, actor)
  );
  if (chosen.length === 0) return 'This agent cannot read any space yet. Ask a workspace admin to grant it one.';
  const lines: string[] = [];
  for (const s of chosen) {
    lines.push(`# ${s.name} — deleted pages`);
    let nodes: TreeNode[];
    try {
      nodes = (await getSpaceArchived(actor, s.id)).nodes;
    } catch (err) {
      if (err instanceof AppError && err.code === 'forbidden') {
        lines.push('(this agent can only read this space, so it cannot list deleted pages)');
        continue;
      }
      throw err;
    }
    if (nodes.length === 0) {
      lines.push('(none)');
      continue;
    }
    const rows = await withTenantTx(actor.tenantId, (tx) =>
      tx
        .select({ id: documents.id, archivedAt: documents.archivedAt })
        .from(documents)
        .where(and(eq(documents.tenantId, actor.tenantId), inArray(documents.id, nodes.map((n) => n.id))))
    );
    const when = new Map(rows.map((r) => [r.id, r.archivedAt?.toISOString().slice(0, 10) ?? '']));
    for (const n of nodes) lines.push(`- ${n.title} (${shortId(n.id)})${n.kind === 'file' ? ' [file]' : ''} — archived ${when.get(n.id)}`);
  }
  const text = lines.join('\n');
  const budget = MAX_RESULT_TOKENS * 4 - CUT_NOTE.length - 100;
  return text.length <= budget ? dataBlock('map', text) : `${dataBlock('map', text.slice(0, text.lastIndexOf('\n', budget)))}\n${CUT_NOTE}`;
}

export const browseTool = defineTool({
  name: 'kinote_browse',
  annotations: { title: 'Browse the wiki', readOnlyHint: true, openWorldHint: false },
  scope: 'read',
  limit: 'search',
  description:
    'The map of the wiki: spaces and their page trees with a one-line summary per page. Call this first. Narrow with space or under; depth 1 to 4 (default 2).',
  input: {
    space: z.string().max(200).optional().describe('A space name or ID'),
    under: z.string().max(64).optional().describe('A page ID: show the tree below it'),
    depth: z.number().int().min(1).max(4).optional(),
    archived: z.boolean().optional().describe('List the deleted (archived) pages instead, for kinote_restore'),
  },
  async run(args, ctx) {
    if (args.archived) return archivedMap(ctx, args.space);
    const depth = args.depth ?? 2;
    const sections = await sectionsFor(ctx, args.space, args.under);
    if (sections.length === 0) return 'This agent cannot read any space yet. Ask a workspace admin to grant it one.';

    const ids = sections.flatMap((s) => shownIds(s, depth));
    const summaries = new Map<string, string>();
    if (ids.length > 0) {
      const rows = await withTenantTx(ctx.actor.tenantId, (tx) =>
        tx
          .select({ id: pageCards.documentId, summary: pageCards.summary })
          .from(pageCards)
          .where(and(eq(pageCards.tenantId, ctx.actor.tenantId), inArray(pageCards.documentId, ids)))
      );
      for (const r of rows) if (r.summary.trim() !== '') summaries.set(r.id, oneLine(r.summary));
    }

    // Titles and summaries are wiki text: the map goes inside one content block; the cut note is the server's.
    const lines = sections.flatMap((s) => render(s, depth, summaries));
    const budget = MAX_RESULT_TOKENS * 4 - CUT_NOTE.length - 100;
    let used = 0;
    const kept: string[] = [];
    for (const line of lines) {
      if (used + line.length + 1 > budget) return `${dataBlock('map', kept.join('\n'))}\n${CUT_NOTE}`;
      kept.push(line);
      used += line.length + 1;
    }
    return dataBlock('map', kept.join('\n'));
  },
});
