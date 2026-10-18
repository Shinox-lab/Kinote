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

export function computePageBadge(input: BadgeInput): string {
  const {
    liveChangedSinceSnapshot,
    agentChangedAt,
    spaceReviewRequired,
    latestVersion,
    indexedVersion,
  } = input;
  const needsReview = spaceReviewRequired || agentChangedAt !== null;

  if (latestVersion?.status === 'withdrawn' && !liveChangedSinceSnapshot) {
    return 'Withdrawn';
  }
  if (latestVersion?.status === 'failed') {
    return 'Index failed';
  }
  if (latestVersion?.status === 'indexing') {
    return 'Indexing…';
  }
  if (latestVersion?.status === 'pending_review') {
    if (liveChangedSinceSnapshot) {
      return `Saved · changed since v${latestVersion.number}, awaiting approval`;
    }
    return 'Saved · not indexed (awaiting approval)';
  }
  if (latestVersion?.status === 'rejected' && !liveChangedSinceSnapshot) {
    return `Not indexed · v${latestVersion.number} rejected`;
  }
  if (liveChangedSinceSnapshot) {
    return needsReview ? 'Saved · not indexed (awaiting approval)' : 'Saved · indexing soon';
  }
  if (indexedVersion) {
    return `Indexed · v${indexedVersion.number}`;
  }
  return needsReview ? 'Saved · not indexed (awaiting approval)' : 'Saved · indexing soon';
}
