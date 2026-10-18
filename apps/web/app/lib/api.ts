// Session/identity + small client for the Living Wiki API.
// The collab WS token in v1 is the opaque "type:id:role" actor string; the
// server validates it per document and everything lands in RLS-scoped writes.

export interface Session {
  apiBase: string;
  collabBase: string;
  tenantId: string;
  tenantSlug: string;
  userId: string;
  userName: string;
  tenantRole: 'owner' | 'admin' | 'member';
}

const SESSION_KEY = 'lw-session';
const PAGES_KEY = (tenantId: string) => `lw-recent-${tenantId}`;

export interface RecentPage {
  id: string;
  title: string;
  spaceId: string;
  slug: string;
}

export function loadSession(): Session | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as Session;
  } catch {
    return null;
  }
}

export function saveSession(s: Session): void {
  localStorage.setItem(SESSION_KEY, JSON.stringify(s));
}

export function signOut(): void {
  const s = loadSession();
  if (s) localStorage.removeItem(PAGES_KEY(s.tenantId));
  localStorage.removeItem(SESSION_KEY);
}

export function loadRecentPages(tenantId: string): RecentPage[] {
  try {
    const raw = localStorage.getItem(PAGES_KEY(tenantId));
    return raw ? (JSON.parse(raw) as RecentPage[]) : [];
  } catch {
    return [];
  }
}

export function rememberPage(tenantId: string, page: RecentPage): void {
  const list = loadRecentPages(tenantId).filter((p) => p.id !== page.id);
  list.unshift(page);
  localStorage.setItem(PAGES_KEY(tenantId), JSON.stringify(list.slice(0, 50)));
}

export class ApiError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export interface Space {
  id: string;
  name: string;
  slug: string;
  kind: string;
  myRole?: string;
  reviewRequired?: boolean;
}

export interface VersionRow {
  id: string;
  number: number;
  status: string;
  reason: string | null;
  createdAt: string;
}

export interface PageDetails {
  id: string;
  spaceId: string;
  parentId: string | null;
  title: string;
  slug: string;
  badge: string;
  liveMarkdown: string;
  latestVersion: VersionRow | null;
  indexedVersion: VersionRow | null;
  versions: VersionRow[];
  archivedAt: string | null;
}

export function headersFor(s: Session): Record<string, string> {
  return {
    'content-type': 'application/json',
    'x-tenant-id': s.tenantId,
    'x-principal-type': 'user',
    'x-principal-id': s.userId,
    'x-tenant-role': s.tenantRole,
  };
}

export const defaults = {
  // Same-origin: in dev, Vite proxies /api/* to the API server
  // (see vite.config.ts server.proxy). Production is served behind the same origin.
  apiBase: '',
  collabBase: 'ws://127.0.0.1:1234',
};

async function request<T>(s: Session, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${s.apiBase}${path}`, {
    ...init,
    headers: { ...headersFor(s), ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    throw new ApiError(body.error ?? 'api_error', body.message ?? res.statusText);
  }
  return (await res.json()) as T;
}

export async function createTenant(
  input: { name: string; slug: string; owner_email: string; owner_name: string },
  apiBase: string = defaults.apiBase
): Promise<{
  tenant: { id: string; slug: string };
  owner: { id: string; name: string };
}> {
  const res = await fetch(`${apiBase}/api/v1/tenants`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    throw new ApiError(body.error ?? 'api_error', body.message ?? res.statusText);
  }
  return res.json();
}

export const api = {
  listSpaces: (s: Session) => request<Space[]>(s, '/api/v1/spaces'),
  createSpace: (s: Session, input: { name: string; slug: string }) =>
    request<Space>(s, '/api/v1/spaces', { method: 'POST', body: JSON.stringify(input) }),
  createPage: (s: Session, input: { space_id: string; title: string; slug: string }) =>
    request<{ document: { id: string } }>(s, '/api/v1/pages', {
      method: 'POST',
      body: JSON.stringify({ ...input, parent_id: null, markdown: '' }),
    }),
  page: (s: Session, pageId: string) => request<PageDetails>(s, `/api/v1/pages/${pageId}`),
  snapshot: (s: Session, pageId: string) =>
    request<VersionRow>(s, `/api/v1/pages/${pageId}/snapshot`, { method: 'POST', body: JSON.stringify({}) }),
};
