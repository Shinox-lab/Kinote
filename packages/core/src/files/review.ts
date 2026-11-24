import { and, eq } from 'drizzle-orm';
import { sources, spaces, type DbTransaction } from '@kinote/db';
import { AppError } from '@kinote/contracts';
import { capturesAlwaysReviewed } from '../routing/access.js';

/**
 * Whether a file version waits for a person's review before readers see it: the space requires review, a
 * connector whose source is not trusted wrote it (a source that cannot be found is not), or an agent with
 * "always review" wrote it (the rule its page edits follow). Text or not, audio or not: the same answer.
 */
export async function fileReviewDecision(
  tx: DbTransaction,
  input: { tenantId: string; spaceId: string; createdByType: 'user' | 'agent' | 'connector'; createdBy: string }
): Promise<boolean> {
  const { tenantId } = input;
  const [space] = await tx
    .select({ reviewRequired: spaces.reviewRequired })
    .from(spaces)
    .where(and(eq(spaces.tenantId, tenantId), eq(spaces.id, input.spaceId)));
  if (!space) throw new AppError('space_not_found');
  if (space.reviewRequired) return true;
  if (input.createdByType === 'connector') {
    const [source] = await tx
      .select({ trusted: sources.trusted })
      .from(sources)
      .where(and(eq(sources.tenantId, tenantId), eq(sources.id, input.createdBy)));
    return source?.trusted !== true;
  }
  if (input.createdByType === 'agent') return capturesAlwaysReviewed(tx, { tenantId, type: 'agent', id: input.createdBy });
  return false;
}
