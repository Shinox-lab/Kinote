import type { TreeResponse } from '@kinote/contracts';
import { TtlCache } from './cache.js';

/**
 * The tree joins every live document to its page and latest version. A short
 * cache collapses the tabs that poll the same space together. API mutations
 * invalidate the space; worker/collab badge changes can lag for this window.
 */
const TREE_CACHE_TTL_MS = 5_000;
const treeCache = new TtlCache<TreeResponse>({
  ttlMs: TREE_CACHE_TTL_MS,
  maxEntries: 2_000,
});

export function getCachedTree(key: string): TreeResponse | undefined {
  return treeCache.get(key);
}

export function cacheTree(key: string, value: TreeResponse): void {
  treeCache.set(key, value);
}

/** Drops one space's live and archived trees, or every space when omitted. */
export function invalidateTreeCache(tenantId: string, spaceId?: string): void {
  treeCache.deletePrefix(spaceId ? `${tenantId}:${spaceId}:` : `${tenantId}:`);
}

export function clearTreeCache(): void {
  treeCache.clear();
}
