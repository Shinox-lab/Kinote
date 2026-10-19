import type { versions, versionContributors, spaces } from '@living-wiki/db';
import type { Actor } from '@living-wiki/core';

export type VersionRow = typeof versions.$inferSelect;
export type ContributorRow = typeof versionContributors.$inferSelect;
export type SpaceRow = typeof spaces.$inferSelect;

/**
 * The authorship rule of approval, shared by `approveVersion` (which refuses
 * with 409 `self_approval` when this is false) and the review queue (which
 * reports it as `canApprove`). It is the rule only: the caller has already
 * established the role (reviewer or above on the document) and that the
 * version is `pending_review`.
 *
 * - An agent never approves (agents are capped at editor by the gate; this
 *   keeps the answer honest for callers that have not applied the gate).
 * - Unless the space allows self-approval, the actor must be neither the
 *   version's creator nor one of its human contributors. Agent contributions
 *   need no exemption of their own: an agent is never the actor, so a human who
 *   did not write the version can always approve what an agent wrote.
 */
export function canApprove(
  actor: Actor,
  version: Pick<VersionRow, 'createdByType' | 'createdBy'>,
  contributors: Array<Pick<ContributorRow, 'principalType' | 'principalId'>>,
  space: Pick<SpaceRow, 'allowSelfApproval'>
): boolean {
  if (actor.principalType !== 'user') return false;
  if (space.allowSelfApproval) return true;

  const isCreator =
    version.createdByType === actor.principalType && version.createdBy === actor.principalId;
  const isHumanContributor = contributors.some(
    (c) => c.principalType === 'user' && c.principalId === actor.principalId
  );
  return !(isCreator || isHumanContributor);
}
