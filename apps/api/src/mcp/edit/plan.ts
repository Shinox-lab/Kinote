import { randomUUID } from 'node:crypto';
import { and, desc, eq, gt } from 'drizzle-orm';
import { blockActivity, pages, spaces, users, type DbTransaction, type DocumentRow } from '@kinote/db';
import { blockMarkdown, EDITABLE_BLOCK_TYPES, markdownBlocks, replaceInBlock, senderAccess, type Actor } from '@kinote/core';
import { blockFullText, type BlockLike } from '@kinote/shared';
import type { CollabClient } from '@kinote/shared';
import { idMatches, shortId } from '../format.js';

/** One edit as the agent sends it. */
export type AgentEdit =
  | { block_id: string; old: string; new: string }
  | { after_block_id: string | null; markdown: string }
  | { remove_block_id: string }
  | { field: string; value: unknown };

/** What became of one edit, in the reply's words. */
export interface EditOutcome {
  /** How the reply names the edit: a block's short id, `after <id>`, `top`, or `field <name>`. */
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

/** The edits of one call sorted: each index has an outcome, or an op to apply, or a suggestion to write. */
export interface EditPlan {
  outcomes: Array<EditOutcome | null>;
  apply: Array<{ index: number; op: CollabOp }>;
  suggest: Array<{ index: number; draft: SuggestionDraft }>;
}

export const CHANGED = 'changed since you read it: read the section again';
export const GONE = 'block not found: read the page again';
export const UNSUPPORTED = "This block can't be edited with kinote_edit; use kinote_capture to propose the change.";
const SAME_BLOCK = 'one edit per block per call';
const EMPTY_MARKDOWN = 'The Markdown has no blocks.';

type Gate = 'protection' | 'no_edit_access' | null;

/** "Jane edited this block just now" / "… 1 minute ago" / "… N minutes ago". */
function editedAgo(name: string, at: Date, now: Date): string {
  const minutes = Math.floor((now.getTime() - at.getTime()) / 60_000);
  const when = minutes < 1 ? 'just now' : minutes === 1 ? '1 minute ago' : `${minutes} minutes ago`;
  return `${name} edited this block ${when}`;
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
 * that check the block's text is still what was read. Field edits are left `null` for the field planner.
 */
export async function planBlockEdits(
  tx: DbTransaction,
  actor: Actor,
  doc: DocumentRow,
  blocks: BlockLike[],
  edits: AgentEdit[],
  now: Date
): Promise<EditPlan> {
  const plan: EditPlan = { outcomes: edits.map(() => null), apply: [], suggest: [] };
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
    return row ? editedAgo(row.name ?? 'Someone', row.at, now) : null;
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

  for (const [i, edit] of edits.entries()) {
    if ('field' in edit) continue;

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
      suggested(i, label, 'removals wait for a person', {
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
    const replaced = replaceInBlock(block, edit.old, edit.new);
    if (!replaced.ok) {
      refuse(i, label, replaced.reason === 'ambiguous' ? `"old" appears ${replaced.count} times in block ${label}; quote more words` : CHANGED);
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
