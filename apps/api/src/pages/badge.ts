export interface BadgeInput {
  liveChangedSinceSnapshot: boolean;
  agentChangedAt: Date | null;
  spaceReviewRequired: boolean;
  latestVersion: {
    number: number;
    status: string;
  } | null;
  indexedVersion: {
    number: number;
  } | null;
}

/**
 * How recently (seconds) a page's live document must have changed for the
 * sidebar to show it as being edited right now.
 */
export const LIVE_EDIT_WINDOW_SECONDS = 60;

// Status predicates. `computePageBadge` and `pageAttention` both decide from
// these, so the badge text and the tree dot cannot drift apart.

/** The latest version is withdrawn and the live text has not moved since. */
export function isWithdrawn(input: BadgeInput): boolean {
  return input.latestVersion?.status === 'withdrawn' && !input.liveChangedSinceSnapshot;
}

/** The latest version failed and nothing newer exists. */
export function isIndexFailed(input: BadgeInput): boolean {
  return input.latestVersion?.status === 'failed';
}

export function isIndexing(input: BadgeInput): boolean {
  return input.latestVersion?.status === 'indexing';
}

/** The latest version is held for approval. */
export function isPendingReview(input: BadgeInput): boolean {
  return input.latestVersion?.status === 'pending_review';
}

/** The latest version was rejected and the live text has not moved since. */
export function isRejected(input: BadgeInput): boolean {
  return input.latestVersion?.status === 'rejected' && !input.liveChangedSinceSnapshot;
}

/** The space requires review, or an agent changed the page. */
export function needsReview(input: BadgeInput): boolean {
  return input.spaceReviewRequired || input.agentChangedAt !== null;
}

/**
 * The page has live (or never-indexed) text that no version-status branch
 * claimed, so it is waiting to be saved: not withdrawn, failed, indexing,
 * pending review or rejected, and either changed since the snapshot or never
 * indexed.
 */
function isUnsavedText(input: BadgeInput): boolean {
  return (
    !isWithdrawn(input) &&
    !isIndexFailed(input) &&
    !isIndexing(input) &&
    !isPendingReview(input) &&
    !isRejected(input) &&
    (input.liveChangedSinceSnapshot || !input.indexedVersion)
  );
}

/** The badge reads "awaiting approval". */
export function isAwaitingApproval(input: BadgeInput): boolean {
  return isPendingReview(input) || (isUnsavedText(input) && needsReview(input));
}

export function computePageBadge(input: BadgeInput): string {
  const { liveChangedSinceSnapshot, latestVersion, indexedVersion } = input;

  if (isWithdrawn(input)) {
    return 'Withdrawn';
  }
  if (isIndexFailed(input)) {
    return 'Index failed';
  }
  if (isIndexing(input)) {
    return 'Indexing…';
  }
  if (isPendingReview(input)) {
    if (liveChangedSinceSnapshot) {
      return `Saved · changed since v${latestVersion!.number}, awaiting approval`;
    }
    return 'Saved · not indexed (awaiting approval)';
  }
  if (isRejected(input)) {
    return `Not indexed · v${latestVersion!.number} rejected`;
  }
  if (isUnsavedText(input)) {
    return needsReview(input) ? 'Saved · not indexed (awaiting approval)' : 'Saved · indexing soon';
  }
  return `Indexed · v${indexedVersion!.number}`;
}

/**
 * The dot the page tree shows beside a page, computed here so the browser
 * computes no status. Priority: failed, then review, then editing. `editing`
 * needs a live change since the snapshot that happened within
 * LIVE_EDIT_WINDOW_SECONDS; opening a page without changing it is `null`.
 */
export function pageAttention(
  input: BadgeInput & { liveUpdatedAt: Date },
  now: Date
): 'failed' | 'review' | 'editing' | null {
  if (isIndexFailed(input)) return 'failed';
  if (isAwaitingApproval(input)) return 'review';
  if (
    input.liveChangedSinceSnapshot &&
    now.getTime() - input.liveUpdatedAt.getTime() <= LIVE_EDIT_WINDOW_SECONDS * 1000
  ) {
    return 'editing';
  }
  return null;
}
