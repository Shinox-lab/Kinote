import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouteContext } from '@tanstack/react-router';
import { api } from './api.js';
import { badgeSettles } from './wiki.js';

// Query keys and hooks. Every key of a workspace starts with its tenant id, so
// switching workspaces never shows another workspace's cached answers.

export const ME_KEY = ['me'] as const;

/** How often a page whose badge is still settling is fetched again. */
const PAGE_POLL_MS = 3000;

/** The workspace the layout resolved from the URL, and the signed-in user's role in it. */
export function useWorkspace() {
  return useRouteContext({ from: '/w/$tenantSlug' });
}

function useTenantKey(...parts: unknown[]) {
  const { tenant } = useWorkspace();
  return ['t', tenant.id, ...parts] as const;
}

export function useSpaces() {
  return useQuery({ queryKey: useTenantKey('spaces'), queryFn: () => api.listSpaces() });
}

/** The workspace's members; `enabled` false for roles the API would refuse (only admins list members). */
export function useMembers(enabled = true) {
  return useQuery({ queryKey: useTenantKey('members'), queryFn: () => api.listMembers(), enabled });
}

export function useGroups() {
  return useQuery({ queryKey: useTenantKey('groups'), queryFn: () => api.listGroups() });
}

export function useGrants(spaceId: string) {
  return useQuery({ queryKey: useTenantKey('grants', spaceId), queryFn: () => api.listGrants(spaceId) });
}

/** A space's live documents (the tree), newest server state each time the key is invalidated. */
export function useSpaceTree(spaceId: string | undefined) {
  return useQuery({
    queryKey: useTenantKey('tree', spaceId),
    queryFn: () => api.spaceTree(spaceId!),
    enabled: spaceId !== undefined,
  });
}

/** A space's archived documents; the API answers space admins only, so `enabled` follows the role. */
export function useArchivedTree(spaceId: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: useTenantKey('archived', spaceId),
    queryFn: () => api.spaceArchived(spaceId!),
    enabled: enabled && spaceId !== undefined,
  });
}

/** A page with its server-computed badge. Invalidated on every `synced` and after each action. */
export function usePage(pageId: string | undefined) {
  return useQuery({
    queryKey: useTenantKey('page', pageId),
    queryFn: () => api.getPage(pageId!),
    enabled: pageId !== undefined,
    // The badge is server state that moves under the page (indexing, review): never trust a cached one.
    staleTime: 0,
    // Nothing tells the browser when indexing finishes, so look again while the server is still on it.
    refetchInterval: (query) => (query.state.data && badgeSettles(query.state.data.badge) ? PAGE_POLL_MS : false),
  });
}

/** The page's changes since its indexed version; keyed under the page so refreshing the page refreshes them. */
export function usePageChanges(pageId: string) {
  return useQuery({
    queryKey: useTenantKey('page', pageId, 'changes'),
    queryFn: () => api.pageChanges(pageId),
    staleTime: 0,
  });
}

/** Refetches the workspace's lists that start with `part` (e.g. 'spaces' also refreshes the grants of a space). */
export function useRefresh() {
  const qc = useQueryClient();
  const { tenant } = useWorkspace();
  return (...part: string[]) => qc.invalidateQueries({ queryKey: ['t', tenant.id, ...part] });
}
