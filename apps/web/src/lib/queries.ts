import { useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouteContext } from '@tanstack/react-router';
import { api } from './api.js';
import { canAdminister } from './console.js';
import { loadSession } from './session.js';
import { capturesBusy } from './capture.js';
import { pagePoll } from './wiki.js';
import { createTitleBatcher } from './links.js';

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

/** How often the tree of the space being read asks again (its status dots move under the page). */
export const TREE_POLL_MS = 30_000;

/**
 * A space's live documents (the tree), newest server state each time the key is
 * invalidated. The sidebar passes `enabled` (only once a space is opened),
 * `refetchOnFocus` (dots are server state) and `poll` (the space being read,
 * while the tab is visible).
 */
export function useSpaceTree(
  spaceId: string | undefined,
  opts: { enabled?: boolean; refetchOnFocus?: boolean; poll?: boolean } = {}
) {
  return useQuery({
    queryKey: useTenantKey('tree', spaceId),
    queryFn: () => api.spaceTree(spaceId!),
    enabled: spaceId !== undefined && (opts.enabled ?? true),
    refetchOnWindowFocus: opts.refetchOnFocus ?? false,
    refetchInterval: opts.poll ? TREE_POLL_MS : false,
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
  // When this page's badge was first seen settling (pagePoll caps the polling).
  const settling = useRef<{ pageId: string | undefined; since: number | null }>({ pageId, since: null });
  return useQuery({
    queryKey: useTenantKey('page', pageId),
    queryFn: () => api.getPage(pageId!),
    enabled: pageId !== undefined,
    // The badge is server state that moves under the page (indexing, review): never trust a cached one.
    staleTime: 0,
    // Nothing tells the browser when indexing finishes, so look again while the
    // server is still on it, for at most two minutes on end (a worker that is
    // down never settles the badge).
    refetchInterval: (query) => {
      if (settling.current.pageId !== pageId) settling.current = { pageId, since: null };
      const next = pagePoll(settling.current.since, query.state.data?.badge, Date.now());
      settling.current.since = next.since;
      return next.interval;
    },
  });
}

/** How often the open page's changes list asks again: the server stores keystrokes a few seconds after they are typed. */
export const CHANGES_POLL_MS = 8_000;

/**
 * The page's changes since its indexed version; keyed under the page so
 * refreshing the page refreshes them. It also asks again on focus and on a
 * timer (while the tab is visible), so what people are typing shows up.
 */
export function usePageChanges(pageId: string) {
  return useQuery({
    queryKey: useTenantKey('page', pageId, 'changes'),
    queryFn: () => api.pageChanges(pageId),
    staleTime: 0,
    refetchOnWindowFocus: true,
    refetchInterval: CHANGES_POLL_MS,
  });
}

/** How often the Updates feed asks again while the tab is visible. */
export const UPDATES_POLL_MS = 30_000;

/** The caller's Continue cards: pages they changed and files they uploaded, newest first. */
export function useRecent(limit = 3) {
  return useQuery({
    queryKey: useTenantKey('recent', String(limit)),
    queryFn: () => api.recent(limit),
    staleTime: 0,
  });
}

/** The workspace's recent changes for Home: asked again on focus and on a timer, never trusted from cache. */
export function useUpdates(limit: number) {
  return useQuery({
    queryKey: useTenantKey('updates', limit),
    queryFn: () => api.updates(limit),
    staleTime: 0,
    refetchOnWindowFocus: true,
    refetchInterval: UPDATES_POLL_MS,
  });
}

/** How often the review queue (and so the sidebar's count) asks again while the tab is visible. */
export const REVIEWS_POLL_MS = 60_000;

/** The review queue (optionally one space's): what the actor can review, empty for anyone who cannot. */
export function useReviews(spaceId?: string) {
  return useQuery({
    queryKey: useTenantKey('reviews', spaceId ?? 'all'),
    queryFn: () => api.reviewQueue(spaceId),
    staleTime: 0,
    // The sidebar shows this count all day: look again on focus and every minute, not only after one's own actions.
    refetchOnWindowFocus: true,
    refetchInterval: REVIEWS_POLL_MS,
  });
}

/** A version's block diff; `enabled` false until someone opens it, so a queue never fetches every diff up front. */
export function useVersionDiff(versionId: string, enabled: boolean) {
  return useQuery({
    queryKey: useTenantKey('versionDiff', versionId),
    queryFn: () => api.versionDiff(versionId),
    enabled,
  });
}

/** A page's versions, newest first; `enabled` false while the history drawer is closed. */
export function usePageVersions(pageId: string, enabled: boolean) {
  return useQuery({
    queryKey: useTenantKey('versions', pageId),
    queryFn: () => api.listVersions(pageId),
    enabled,
    staleTime: 0,
  });
}

/** The block diff between two numbered versions of a page; nothing is asked until both are chosen. */
export function useComparison(pageId: string, pair: { from: number; to: number } | null) {
  return useQuery({
    queryKey: useTenantKey('compare', pageId, pair?.from, pair?.to),
    queryFn: () => api.compareVersions(pageId, pair!.from, pair!.to),
    enabled: pair !== null,
  });
}

/** Names to show for authors (only workspace admins may list members) and the signed-in user's id. */
export function useAuthorNames() {
  const { role } = useWorkspace();
  const { data: members = [] } = useMembers(canAdminister(role));
  return { names: new Map(members.map((m) => [m.userId, m.name])), selfId: loadSession()?.user.id ?? null };
}

/** Refetches the workspace's lists that start with `part` (e.g. 'spaces' also refreshes the grants of a space). */
export function useRefresh() {
  const qc = useQueryClient();
  const { tenant } = useWorkspace();
  return (...part: string[]) => qc.invalidateQueries({ queryKey: ['t', tenant.id, ...part] });
}

/** A file with its server-computed badge; looked at again while the server is still reading or indexing it. */
export function useFile(fileId: string | undefined) {
  const settling = useRef<{ fileId: string | undefined; since: number | null }>({ fileId, since: null });
  return useQuery({
    queryKey: useTenantKey('file', fileId),
    queryFn: () => api.getFile(fileId!),
    enabled: fileId !== undefined,
    staleTime: 0,
    refetchInterval: (query) => {
      if (settling.current.fileId !== fileId) settling.current = { fileId, since: null };
      const next = pagePoll(settling.current.since, query.state.data?.badge, Date.now());
      settling.current.since = next.since;
      return next.interval;
    },
  });
}

/** A file's versions, newest first. */
export function useFileVersions(fileId: string, enabled = true) {
  return useQuery({
    queryKey: useTenantKey('file', fileId, 'versions'),
    queryFn: () => api.fileVersions(fileId),
    enabled,
    staleTime: 0,
  });
}

/** The text read from a file version (what a viewer without edit rights may see of it). */
export function useVersionText(versionId: string, enabled = true) {
  return useQuery({
    queryKey: useTenantKey('versionText', versionId),
    queryFn: () => api.versionText(versionId),
    enabled,
  });
}

/** The chunks a file version is (or would be) searched by; `enabled` false until someone opens them. */
export function useVersionChunks(versionId: string, enabled: boolean) {
  return useQuery({
    queryKey: useTenantKey('versionChunks', versionId),
    queryFn: () => api.versionChunks(versionId),
    enabled,
  });
}

/** The workspace's sources (admins only, so `enabled` follows the role). */
export function useSources(enabled = true) {
  return useQuery({ queryKey: useTenantKey('sources'), queryFn: () => api.listSources(), enabled });
}

/** How often the Capture page asks again while some capture is still being routed. */
export const CAPTURE_POLL_MS = 2_000;

/** The actor's captures, newest first; polled only while one is queued or routing. */
export function useCaptures() {
  return useQuery({
    queryKey: useTenantKey('captures'),
    queryFn: () => api.listCaptures(),
    staleTime: 0,
    refetchInterval: (query) => (capturesBusy(query.state.data) ? CAPTURE_POLL_MS : false),
  });
}

/** One capture with its thread and receipt; polled while it is still being routed. */
export function useCapture(id: string | undefined, enabled = true) {
  return useQuery({
    queryKey: useTenantKey('capture', id),
    queryFn: () => api.getCapture(id!),
    enabled: enabled && id !== undefined,
    staleTime: 0,
    refetchInterval: (query) => (capturesBusy(query.state.data ? [query.state.data.capture] : undefined) ? CAPTURE_POLL_MS : false),
  });
}

/** Facts the engine would not place, from the actor's captures. */
export function useNeedsHome() {
  return useQuery({ queryKey: useTenantKey('needs-home'), queryFn: () => api.needsHome(), staleTime: 0 });
}

/** Document captures waiting for a person to choose where their page goes. */
export function useNeedsHomeDocuments() {
  return useQuery({ queryKey: useTenantKey('needs-home', 'documents'), queryFn: () => api.needsHomeDocuments(), staleTime: 0 });
}

/** A page's open suggestions. */
export function usePageSuggestions(pageId: string) {
  return useQuery({
    queryKey: useTenantKey('page', pageId, 'suggestions'),
    queryFn: () => api.pageSuggestions(pageId),
    staleTime: 0,
  });
}

/** One capture's changes on a page ("changes from this capture"); nothing is asked without a capture. */
export function usePageCaptureChanges(pageId: string, captureId: string | undefined) {
  return useQuery({
    queryKey: useTenantKey('page', pageId, 'capture-changes', captureId),
    queryFn: () => api.pageCaptureChanges(pageId, captureId!),
    enabled: captureId !== undefined,
  });
}

const loadTitle = createTitleBatcher((ids) => api.documentTitles(ids));

/** A link target's current title; null when the reader can't open it (archived, or no access). */
export function useDocumentTitle(documentId: string) {
  return useQuery({
    queryKey: useTenantKey('doc-title', documentId.toLowerCase()),
    queryFn: () => loadTitle(documentId),
    staleTime: 60_000,
  });
}

/** Pages linking to a page, and the document pages the routing engine joined to it, both ways. */
export function usePageConnections(pageId: string) {
  return useQuery({
    queryKey: useTenantKey('page', pageId, 'connections'),
    queryFn: () => api.pageConnections(pageId),
  });
}

/** A page's comment threads, for the comments panel. */
export function usePageThreads(pageId: string, enabled = true) {
  return useQuery({
    queryKey: useTenantKey('page', pageId, 'threads'),
    queryFn: () => api.pageThreads(pageId),
    enabled,
  });
}

/** The caller's notifications: asked again every 30 seconds and on focus. */
export function useNotifications() {
  return useQuery({
    queryKey: useTenantKey('notifications'),
    queryFn: () => api.notifications(),
    staleTime: 0,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });
}
