import { randomUUID } from 'node:crypto';
import { and, desc, eq, gt } from 'drizzle-orm';
import { blockActivity, pages, spaces, users, type DbTransaction, type DocumentRow } from '@kinote/db';
import { blockMarkdown, EDITABLE_BLOCK_TYPES, markdownBlocks, replaceInBlock, resolveFieldValue, rowCollectionOf, senderAccess, type Actor } from '@kinote/core';
import { canonicalFieldJson, FIELD_BLOCK_PREFIX, type FieldDef } from '@kinote/contracts';
import { blockFullText, type BlockLike } from '@kinote/shared';
import type { CollabClient } from '@kinote/shared';
import { idMatches, shortId } from '../format.js';

/** One edit as the agent sends it. */
export type AgentEdit =
  | { block_id: string; old: string; new: string }
  | { after_block_id: string | null; markdown: string }
  | { remove_block_id: string }
  | { field: string; value: unknown }
  | { title: string };

/** What became of one edit, in the reply's words. */
export interface EditOutcome {
  /** How the reply names the edit: a block's short id, `after <id>`, `top`, `field <name>`, or `title`. */
  label: string;
  result: 'applied' | 'suggested' | 'refused';
  detail: string;
}

export type CollabOp = Parameters<CollabClient['applyBlockOps']>[0]['ops'][number];

/** A suggestion row's own columns (tenant, page, space and proposer are added when written). */
export interface SuggestionDraft {
  kind: 'remove' | 'replace' | 'insert' | 'set_field';
  blockId: string | null;
  afterBlockId: string | null;
  proposedMarkdown: string | null;
  proposedBlocks: unknown;
  expectedText: string | null;
  blockedBy: 'removal' | 'protection' | 'no_edit_access';
}

/** The page as the planner reads it: its top-level blocks and its field values. */
export interface LivePage {
  blocks: BlockLike[];
  fields: Record<string, unknown> | null;
}

/** The edits of one call sorted: each index has an outcome, or an op to apply, or a suggestion to write. */
export interface EditPlan {
  outcomes: Array<EditOutcome | null>;
  apply: Array<{ index: number; op: CollabOp }>;
  suggest: Array<{ index: number; draft: SuggestionDraft }>;
  /** The page's new title, when the call renames it (applied apart from the block ops). */
  rename: { index: number; title: string } | null;
}

export const CHANGED = 'changed since you read it: read the section again';
export const NOT_FOUND = 'not found in the block: quote the words as they read, without Markdown, or read the section again if it changed';

/**
 * The words of a Markdown quote as a block's text reads them: `[text](url)` becomes its text, and bold, italic,
 * strike and code markers go. kinote_read shows blocks as Markdown; their text has none of it.
 */
export function plainWords(markdown: string): string {
  return markdown
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|~~|`)/g, '')
    .replace(/(^|[^\w*])[*_]([^*_\s][^*_]*?)[*_](?=[^\w*]|$)/g, '$1$2');
}
export const GONE = 'block not found: read the page again';
export const UNSUPPORTED = "This block can't be edited with kinote_edit; use kinote_capture to propose the change.";
const SAME_BLOCK = 'one edit per block per call';
const EMPTY_MARKDOWN = 'The Markdown has no blocks.';
const NOT_A_ROW = 'This page is not a collection row';
const REMOVAL = 'removals wait for a person';
const BAD_TITLE = 'A title needs 1 to 200 characters';
const ONE_TITLE = 'one title edit per call';
const NO_RENAME = 'no edit access: a person can rename it';

/** What a field takes, for a refused value: `Due expects a date (YYYY-MM-DD)`. */
function expects(def: FieldDef): string {
  const choices = (def.options.choices ?? []).map((c) => c.name).join(', ');
  switch (def.type) {
    case 'number':
      return 'a number';
    case 'date':
      return 'a date (YYYY-MM-DD)';
    case 'select':
      return `one of: ${choices}`;
    case 'multi_select':
      return `a list of: ${choices}`;
    case 'person':
      return 'workspace members, by name';
    case 'checkbox':
      return 'true or false';
    case 'page':
      return 'pages in this space, by title';
    default:
      return 'text';
  }
}

type Gate = 'protection' | 'no_edit_access' | null;

/** "Jane edited this block (or field) just now" / "… 1 minute ago" / "… N minutes ago". */
function editedAgo(name: string, at: Date, now: Date, what: 'block' | 'field'): string {
  const minutes = Math.floor((now.getTime() - at.getTime()) / 60_000);
  const when = minutes < 1 ? 'just now' : minutes === 1 ? '1 minute ago' : `${minutes} minutes ago`;
  return `${name} edited this ${what} ${when}`;
}

/** The block a ref names among the page's top-level blocks, or why it can't be edited. */
function resolveBlock(blocks: BlockLike[], ref: string): { block: BlockLike } | { refused: string } {
  const top = blocks.filter((b) => idMatches(b.id, ref));
  if (top.length > 1) return { refused: `Block id "${ref}" is ambiguous; give more characters` };
  if (top.length === 1) return { block: top[0]! };
  const nested = (list: BlockLike[]): boolean => list.some((b) => (b.children ?? []).some((c) => idMatches(c.id, ref)) || nested(b.children ?? []));
  return { refused: nested(blocks) ? UNSUPPORTED : GONE };
}

/**
 * Sorts a call's block edits against the page as it is now (`blocks`, read after a flush): refusals get their
 * outcome, edits that need a person become suggestion drafts (removals always; a block a person changed within
 * the space's protection window; any edit where the agent cannot edit the space now), the rest become collab ops
 * that check the block's text is still what was read. Field edits on a collection row alike: by field name or
 * id, the value resolved like a routed one (choice, member and page names), clearing one a removal.
 */
export async function planEdits(tx: DbTransaction, actor: Actor, doc: DocumentRow, live: LivePage, edits: AgentEdit[], now: Date): Promise<EditPlan> {
  const blocks = live.blocks;
  const plan: EditPlan = { outcomes: edits.map(() => null), apply: [], suggest: [], rename: null };
  const access = await senderAccess(tx, actor);
  const canEdit = access.editable.includes(doc.spaceId);
  const [space] = await tx
    .select({ seconds: spaces.humanProtectionSeconds })
    .from(pages)
    .innerJoin(spaces, and(eq(spaces.tenantId, pages.tenantId), eq(spaces.id, pages.spaceId)))
    .where(and(eq(pages.tenantId, doc.tenantId), eq(pages.documentId, doc.id)));
  const since = new Date(now.getTime() - (space?.seconds ?? 0) * 1000);

  /** Who last changed the block within the window, worded for the reply; null when no person did. */
  const protectedBy = async (blockId: string): Promise<string | null> => {
    const [row] = await tx
      .select({ at: blockActivity.changedAt, name: users.name })
      .from(blockActivity)
      .leftJoin(users, eq(users.id, blockActivity.actorId))
      .where(
        and(
          eq(blockActivity.tenantId, doc.tenantId),
          eq(blockActivity.pageId, doc.id),
          eq(blockActivity.blockId, blockId),
          eq(blockActivity.actorType, 'user'),
          gt(blockActivity.changedAt, since)
        )
      )
      .orderBy(desc(blockActivity.changedAt))
      .limit(1);
    return row ? editedAgo(row.name ?? 'Someone', row.at, now, blockId.startsWith(FIELD_BLOCK_PREFIX) ? 'field' : 'block') : null;
  };
  const gateFor = async (blockId: string | null): Promise<{ gate: Gate; detail: string }> => {
    if (!canEdit) return { gate: 'no_edit_access', detail: 'no edit access' };
    const by = blockId ? await protectedBy(blockId) : null;
    return by ? { gate: 'protection', detail: by } : { gate: null, detail: '' };
  };

  const addressed = new Set<string>();
  /** The last block an earlier insert of this call put after an anchor, so later inserts follow it. */
  const lastAfter = new Map<string | null, string>();
  const refuse = (i: number, label: string, detail: string) => {
    plan.outcomes[i] = { label, result: 'refused', detail };
  };
  const suggested = (i: number, label: string, detail: string, draft: SuggestionDraft) => {
    plan.outcomes[i] = { label, result: 'suggested', detail };
    plan.suggest.push({ index: i, draft });
  };

  let row: Awaited<ReturnType<typeof rowCollectionOf>> | undefined;
  let titled = false;
  for (const [i, edit] of edits.entries()) {
    if ('title' in edit) {
      const title = edit.title.trim();
      if (titled) refuse(i, 'title', ONE_TITLE);
      else if (title.length < 1 || title.length > 200) refuse(i, 'title', BAD_TITLE);
      else if (!canEdit) refuse(i, 'title', NO_RENAME);
      else {
        plan.rename = { index: i, title };
        plan.outcomes[i] = { label: 'title', result: 'applied', detail: '' };
      }
      titled = true;
      continue;
    }
    if ('field' in edit) {
      row ??= await rowCollectionOf(tx, doc.tenantId, doc.id);
      if (!row) {
        refuse(i, `field ${edit.field}`, NOT_A_ROW);
        continue;
      }
      const want = edit.field.trim().toLowerCase();
      const def = row.fields.find((d) => d.id === edit.field || d.name.trim().toLowerCase() === want);
      if (!def) {
        refuse(i, `field ${edit.field}`, `Unknown field "${edit.field}". Fields: ${row.fields.map((d) => d.name).join(', ')}`);
        continue;
      }
      const label = `field ${def.name}`;
      const key = `${FIELD_BLOCK_PREFIX}${def.id}`;
      if (addressed.has(key)) {
        refuse(i, label, SAME_BLOCK);
        continue;
      }
      addressed.add(key);
      const expected = canonicalFieldJson(live.fields?.[def.id] ?? null);
      const draft = (value: unknown, blockedBy: SuggestionDraft['blockedBy']): SuggestionDraft => ({
        kind: 'set_field',
        blockId: key,
        afterBlockId: null,
        proposedMarkdown: canonicalFieldJson(value),
        proposedBlocks: null,
        expectedText: expected,
        blockedBy,
      });
      if (edit.value === null) {
        suggested(i, label, REMOVAL, draft(null, 'removal'));
        continue;
      }
      const resolved = await resolveFieldValue(tx, doc.tenantId, def, edit.value, doc.spaceId);
      if (!resolved.ok) {
        refuse(i, label, `${def.name} expects ${expects(def)}`);
        continue;
      }
      if (resolved.value === null) {
        suggested(i, label, REMOVAL, draft(null, 'removal'));
        continue;
      }
      const { gate, detail } = await gateFor(key);
      if (gate) {
        suggested(i, label, detail, draft(resolved.value, gate));
        continue;
      }
      plan.apply.push({ index: i, op: { op: 'set_field', fieldId: def.id, value: resolved.value, expected } });
      plan.outcomes[i] = { label, result: 'applied', detail: '' };
      continue;
    }

    if ('after_block_id' in edit) {
      let anchor: BlockLike | null = null;
      if (edit.after_block_id !== null) {
        const found = resolveBlock(blocks, edit.after_block_id);
        if ('refused' in found) {
          refuse(i, `after ${edit.after_block_id}`, found.refused === UNSUPPORTED ? UNSUPPORTED : found.refused);
          continue;
        }
        anchor = found.block;
      }
      const label = anchor ? `after ${shortId(anchor.id)}` : 'top';
      const fresh = (await markdownBlocks(edit.markdown)).map((b) => ({ ...b, id: randomUUID() }));
      if (fresh.length === 0) {
        refuse(i, label, EMPTY_MARKDOWN);
        continue;
      }
      const { gate, detail } = await gateFor(null);
      if (gate) {
        suggested(i, label, detail, {
          kind: 'insert',
          blockId: null,
          afterBlockId: anchor?.id ?? null,
          proposedMarkdown: edit.markdown,
          proposedBlocks: fresh,
          expectedText: null,
          blockedBy: gate,
        });
        continue;
      }
      const key = anchor?.id ?? null;
      const after = lastAfter.get(key) ?? key;
      lastAfter.set(key, fresh[fresh.length - 1]!.id);
      plan.apply.push({ index: i, op: { op: 'insert_after', after, blocks: fresh as unknown as Record<string, unknown>[] } });
      plan.outcomes[i] = { label, result: 'applied', detail: '' };
      continue;
    }

    const ref = 'block_id' in edit ? edit.block_id : edit.remove_block_id;
    const found = resolveBlock(blocks, ref);
    if ('refused' in found) {
      refuse(i, ref, found.refused);
      continue;
    }
    const block = found.block;
    const label = shortId(block.id);
    if (addressed.has(block.id)) {
      refuse(i, label, SAME_BLOCK);
      continue;
    }
    addressed.add(block.id);
    const expectedText = blockFullText(block);

    if ('remove_block_id' in edit) {
      suggested(i, label, REMOVAL, {
        kind: 'remove',
        blockId: block.id,
        afterBlockId: null,
        proposedMarkdown: null,
        proposedBlocks: null,
        expectedText,
        blockedBy: 'removal',
      });
      continue;
    }

    if (!EDITABLE_BLOCK_TYPES.has(block.type)) {
      refuse(i, label, UNSUPPORTED);
      continue;
    }
    let replaced = replaceInBlock(block, edit.old, edit.new);
    // Quoted as kinote_read shows it (Markdown)? Match its plain words, and write the new words plain too.
    if (!replaced.ok && replaced.reason === 'not_found' && plainWords(edit.old) !== edit.old) {
      replaced = replaceInBlock(block, plainWords(edit.old), plainWords(edit.new));
    }
    if (!replaced.ok) {
      refuse(i, label, replaced.reason === 'ambiguous' ? `"old" appears ${replaced.count} times in block ${label}; quote more words` : NOT_FOUND);
      continue;
    }
    // The block's own content only: collab keeps the children of a replaced block.
    const next: BlockLike = { ...replaced.block, children: [] };
    const { gate, detail } = await gateFor(block.id);
    if (gate) {
      suggested(i, label, detail, {
        kind: 'replace',
        blockId: block.id,
        afterBlockId: null,
        proposedMarkdown: await blockMarkdown(next),
        proposedBlocks: [next],
        expectedText,
        blockedBy: gate,
      });
      continue;
    }
    plan.apply.push({ index: i, op: { op: 'replace', blockId: block.id, blocks: [next as unknown as Record<string, unknown>], expectedText } });
    plan.outcomes[i] = { label, result: 'applied', detail: '' };
  }
  return plan;
}
