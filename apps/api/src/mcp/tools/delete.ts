import { and, count, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { documents, spaces, suggestions, withTenantTx, type DbTransaction, type DocumentRow } from '@kinote/db';
import { AppError } from '@kinote/contracts';
import { capturesAlwaysReviewed, requireDocumentRole, type Actor } from '@kinote/core';
import { archivePageTx, lockPage } from '../../routes/pages.js';
import { shortId } from '../format.js';
import { resolvePageRef, ToolError } from '../refs.js';
import { defineTool } from '../tool.js';

export const NO_DELETE_ACCESS = 'no edit access: a person can delete it';
const ALREADY_DELETED = 'The page is already deleted.';
const FILE_REFUSED = 'kinote_delete removes pages, not files. A person can archive a file in Kinote.';

const asked = (title: string, id: string) =>
  `Asked to delete "${title}": waiting for a person (request ${shortId(id)}). They can decide it in Kinote or with kinote_review.`;

/** The live page the agent names; an archived one is refused as already deleted, anything else as not found. */
async function livePage(tx: DbTransaction, actor: Actor, ref: string): Promise<DocumentRow> {
  try {
    return await resolvePageRef(tx, actor, ref);
  } catch (err) {
    if (!(err instanceof ToolError)) throw err;
    const archived = await resolvePageRef(tx, actor, ref, { archived: true }).catch(() => null);
    throw archived ? new ToolError(ALREADY_DELETED) : err;
  }
}

/**
 * Archives a page, or asks a person to: an agent that always reviews, or a space that requires review, makes a
 * delete request (an `archive` suggestion) instead. Archiving is reversible; nothing is removed for good.
 */
export const deleteTool = defineTool({
  name: 'kinote_delete',
  scope: 'edit',
  limit: 'edit',
  writes: true,
  description:
    'Delete (archive) a page, saying why. Where changes need review it becomes a request a person decides. A person can restore a deleted page, and so can kinote_restore. A page with sub-pages cannot be deleted: delete or move them first.',
  input: {
    page_id: z.string().min(1).max(64),
    reason: z.string().trim().min(1).max(500),
  },
  async run(args, ctx) {
    const { actor, agent } = ctx;
    return withTenantTx(actor.tenantId, async (tx) => {
      const doc = await livePage(tx, actor, args.page_id);
      if (doc.kind === 'file') throw new ToolError(FILE_REFUSED);
      ctx.touch([doc.id]);
      try {
        await requireDocumentRole(tx, actor, doc, 'editor');
      } catch (err) {
        if (err instanceof AppError) throw new ToolError(NO_DELETE_ACCESS);
        throw err;
      }
      const [{ n }] = (await tx
        .select({ n: count() })
        .from(documents)
        .where(and(eq(documents.tenantId, actor.tenantId), eq(documents.parentId, doc.id), isNull(documents.archivedAt)))) as [{ n: number }];
      if (n > 0) throw new ToolError(`It has ${n} sub-pages: delete or move them first.`);

      const [open] = await tx
        .select({ id: suggestions.id })
        .from(suggestions)
        .where(
          and(eq(suggestions.tenantId, actor.tenantId), eq(suggestions.documentId, doc.id), eq(suggestions.kind, 'archive'), eq(suggestions.status, 'open'))
        );
      if (open) return asked(doc.title, open.id);

      const [space] = await tx
        .select({ reviewRequired: spaces.reviewRequired })
        .from(spaces)
        .where(and(eq(spaces.tenantId, actor.tenantId), eq(spaces.id, doc.spaceId)));
      const review = space!.reviewRequired || (await capturesAlwaysReviewed(tx, { tenantId: actor.tenantId, type: 'agent', id: agent.agentId }));
      if (review) {
        const [row] = await tx
          .insert(suggestions)
          .values({
            tenantId: actor.tenantId,
            documentId: doc.id,
            spaceId: doc.spaceId,
            kind: 'archive',
            reason: args.reason,
            blockedBy: 'no_edit_access',
            proposedByType: 'agent',
            proposedBy: agent.agentId,
          })
          .returning({ id: suggestions.id });
        return asked(doc.title, row!.id);
      }

      await archivePageTx(tx, actor, await lockPage(tx, actor.tenantId, doc.id));
      return `Deleted "${doc.title}". A person can restore it from the page.`;
    });
  },
});
