/** The sidebar tree's base poll interval. */
export const TREE_POLL_MS = 30_000;
/** Spread the poll across this window so many open tabs do not refetch together. */
export const TREE_POLL_JITTER_MS = 5_000;

/** The tree poll delay for one tab: base interval plus a stable per-tab jitter. */
export function treePollInterval(random: () => number = Math.random): number {
  return TREE_POLL_MS + Math.floor(random() * TREE_POLL_JITTER_MS);
}
