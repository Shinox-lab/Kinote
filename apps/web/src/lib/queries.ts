import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouteContext } from '@tanstack/react-router';
import { api } from './api.js';

// Query keys and hooks. Every key of a workspace starts with its tenant id, so
// switching workspaces never shows another workspace's cached answers.

export const ME_KEY = ['me'] as const;

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

export function useMembers() {
  return useQuery({ queryKey: useTenantKey('members'), queryFn: () => api.listMembers() });
}

export function useGroups() {
  return useQuery({ queryKey: useTenantKey('groups'), queryFn: () => api.listGroups() });
}

export function useGrants(spaceId: string) {
  return useQuery({ queryKey: useTenantKey('grants', spaceId), queryFn: () => api.listGrants(spaceId) });
}

/** Refetches the workspace's lists that start with `part` (e.g. 'spaces' also refreshes the grants of a space). */
export function useRefresh() {
  const qc = useQueryClient();
  const { tenant } = useWorkspace();
  return (...part: string[]) => qc.invalidateQueries({ queryKey: ['t', tenant.id, ...part] });
}
