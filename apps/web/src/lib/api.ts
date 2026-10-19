import {
  AcceptInvitationResponseSchema,
  AskResponseSchema,
  AuthResponseSchema,
  BlockDiffSchema,
  CollabTokenResponseSchema,
  CreateTenantResponseSchema,
  DocumentSummarySchema,
  ERROR_SENTENCES,
  GrantListSchema,
  GroupListSchema,
  GroupMemberResponseSchema,
  GroupSchema,
  InviteMemberResponseSchema,
  MeResponseSchema,
  MemberListSchema,
  MemberSchema,
  PageDetailsSchema,
  PageSummarySchema,
  RetryVersionResponseSchema,
  ReviewListSchema,
  SearchResponseSchema,
  SpaceListSchema,
  SpaceResponseSchema,
  SpaceSchema,
  TreeResponseSchema,
  UpsertGrantResponseSchema,
  VersionDetailSchema,
  VersionListSchema,
  VersionSummarySchema,
  type AcceptInvitationRequest,
  type AddGroupMemberRequest,
  type ApproveVersionRequest,
  type AskRequest,
  type CreateGroupRequest,
  type CreatePageRequest,
  type CreateSpaceRequest,
  type CreateTenantRequest,
  type InviteMemberRequest,
  type MovePageRequest,
  type RejectVersionRequest,
  type SearchRequest,
  type SignInRequest,
  type SignUpRequest,
  type UpdateMemberRoleRequest,
  type UpdateSpaceSettings,
  type UpsertSpaceGrant,
} from '@living-wiki/contracts';

// Typed client for the Living Wiki API: every reply is checked against its
// contract schema. Request bodies are snake_case, replies camelCase. Framework
// free, so the console (or a test) can use it as is.

/** What the client needs of a Zod schema (any `ZodType` fits). */
export interface ReplySchema<T> {
  safeParse(data: unknown):
    | { success: true; data: T }
    | { success: false; error: { issues: ReadonlyArray<{ path: ReadonlyArray<string | number>; code: string }> } };
}

const NO_CONTENT: ReplySchema<undefined> = {
  safeParse: () => ({ success: true, data: undefined }),
};

/** An error answer of the API: `code` is the contract code, `message` its contract sentence. */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status = 0) {
    super(errorSentence(code));
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

const GENERIC_SENTENCE = 'Something went wrong. Please try again.';

/** The contract sentence for an error code; a generic sentence (never the code itself) for an unknown one. */
export function errorSentence(code: string): string {
  return Object.hasOwn(ERROR_SENTENCES, code)
    ? ERROR_SENTENCES[code as keyof typeof ERROR_SENTENCES]
    : GENERIC_SENTENCE;
}

// --- Session ------------------------------------------------------------------

export interface Session {
  token: string;
  /** The tenant the requests act in (x-tenant-id); null until one is chosen. */
  tenantId: string | null;
}

const SESSION_KEY = 'living-wiki.session';

let session: Session | null = null;
let sessionLoaded = false;
let apiBase = '';

/** Where the API lives; the default is the page's own origin. */
export function setApiBase(base: string): void {
  apiBase = base;
}

/** The current session, restored from localStorage the first time it is asked for. */
export function getSession(): Session | null {
  if (!sessionLoaded) {
    sessionLoaded = true;
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      const stored = raw ? (JSON.parse(raw) as Partial<Session>) : null;
      if (stored && typeof stored.token === 'string') {
        session = { token: stored.token, tenantId: stored.tenantId ?? null };
      }
    } catch {
      // No storage (private window, tests): the session lives in memory only.
    }
  }
  return session;
}

/** Sets (or, with null, clears) the session and remembers it across reloads. */
export function setSession(next: Session | null): void {
  session = next;
  sessionLoaded = true;
  try {
    if (next) localStorage.setItem(SESSION_KEY, JSON.stringify(next));
    else localStorage.removeItem(SESSION_KEY);
  } catch {
    // Storage unavailable: in-memory only.
  }
}

// --- Request ------------------------------------------------------------------

/**
 * Calls the API and returns the reply parsed with `schema`. An error body
 * `{ error: code }` throws ApiError(code); a reply the schema rejects throws a
 * plain Error naming the offending paths (never the values).
 */
export async function request<T>(
  path: string,
  schema: ReplySchema<T>,
  init: RequestInit = {}
): Promise<T> {
  const headers = new Headers(init.headers);
  const current = getSession();
  if (current) {
    headers.set('authorization', `Bearer ${current.token}`);
    if (current.tenantId) headers.set('x-tenant-id', current.tenantId);
  }
  if (init.body !== undefined && init.body !== null && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }

  const res = await fetch(`${apiBase}${path}`, { ...init, headers });
  if (!res.ok) {
    const body: unknown = await res.json().catch(() => null);
    const code =
      typeof body === 'object' && body !== null && typeof (body as { error?: unknown }).error === 'string'
        ? (body as { error: string }).error
        : 'internal_error';
    throw new ApiError(code, res.status);
  }

  const data: unknown = res.status === 204 ? undefined : await res.json().catch(() => undefined);
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.code}`)
      .join('; ');
    throw new Error(`Unexpected reply from ${path} (${issues})`);
  }
  return parsed.data;
}

const e = encodeURIComponent;
const send = (method: 'POST' | 'PATCH', body?: unknown): RequestInit =>
  body === undefined ? { method } : { method, body: JSON.stringify(body) };
const del: RequestInit = { method: 'DELETE' };

/** One thin wrapper per route the console uses. */
export const api = {
  // Auth
  signUp: (body: SignUpRequest) => request('/api/v1/auth/sign-up', AuthResponseSchema, send('POST', body)),
  signIn: (body: SignInRequest) => request('/api/v1/auth/sign-in', AuthResponseSchema, send('POST', body)),
  signOut: () => request('/api/v1/auth/sign-out', NO_CONTENT, send('POST')),
  me: () => request('/api/v1/me', MeResponseSchema),
  createTenant: (body: CreateTenantRequest) =>
    request('/api/v1/tenants', CreateTenantResponseSchema, send('POST', body)),
  invite: (body: InviteMemberRequest) =>
    request('/api/v1/invitations', InviteMemberResponseSchema, send('POST', body)),
  acceptInvitation: (body: AcceptInvitationRequest) =>
    request('/api/v1/invitations/accept', AcceptInvitationResponseSchema, send('POST', body)),

  // Spaces
  listSpaces: () => request('/api/v1/spaces', SpaceListSchema),
  createSpace: (body: CreateSpaceRequest) => request('/api/v1/spaces', SpaceResponseSchema, send('POST', body)),
  getSpace: (id: string) => request(`/api/v1/spaces/${e(id)}`, SpaceResponseSchema),
  updateSpace: (id: string, body: UpdateSpaceSettings) =>
    request(`/api/v1/spaces/${e(id)}`, SpaceSchema, send('PATCH', body)),
  archiveSpace: (id: string) => request(`/api/v1/spaces/${e(id)}/archive`, SpaceResponseSchema, send('POST')),
  spaceTree: (id: string) => request(`/api/v1/spaces/${e(id)}/tree`, TreeResponseSchema),
  spaceArchived: (id: string) => request(`/api/v1/spaces/${e(id)}/archived`, TreeResponseSchema),

  // Space grants
  listGrants: (spaceId: string) => request(`/api/v1/spaces/${e(spaceId)}/grants`, GrantListSchema),
  upsertGrant: (spaceId: string, body: UpsertSpaceGrant) =>
    request(`/api/v1/spaces/${e(spaceId)}/grants`, UpsertGrantResponseSchema, send('POST', body)),
  deleteGrant: (spaceId: string, principalType: string, principalId: string) =>
    request(`/api/v1/spaces/${e(spaceId)}/grants/${e(principalType)}/${e(principalId)}`, NO_CONTENT, del),

  // Members and groups
  listMembers: () => request('/api/v1/members', MemberListSchema),
  changeMemberRole: (userId: string, body: UpdateMemberRoleRequest) =>
    request(`/api/v1/members/${e(userId)}`, MemberSchema, send('PATCH', body)),
  removeMember: (userId: string) => request(`/api/v1/members/${e(userId)}`, NO_CONTENT, del),
  listGroups: () => request('/api/v1/groups', GroupListSchema),
  createGroup: (body: CreateGroupRequest) => request('/api/v1/groups', GroupSchema, send('POST', body)),
  addGroupMember: (groupId: string, body: AddGroupMemberRequest) =>
    request(`/api/v1/groups/${e(groupId)}/members`, GroupMemberResponseSchema, send('POST', body)),
  removeGroupMember: (groupId: string, principalType: string, principalId: string) =>
    request(`/api/v1/groups/${e(groupId)}/members/${e(principalType)}/${e(principalId)}`, NO_CONTENT, del),

  // Pages
  createPage: (body: CreatePageRequest) => request('/api/v1/pages', PageSummarySchema, send('POST', body)),
  getPage: (id: string) => request(`/api/v1/pages/${e(id)}`, PageDetailsSchema),
  movePage: (id: string, body: MovePageRequest) =>
    request(`/api/v1/pages/${e(id)}/move`, DocumentSummarySchema, send('POST', body)),
  archivePage: (id: string) => request(`/api/v1/pages/${e(id)}/archive`, DocumentSummarySchema, send('POST')),
  restorePage: (id: string) => request(`/api/v1/pages/${e(id)}/restore`, DocumentSummarySchema, send('POST')),
  withdrawPage: (id: string) => request(`/api/v1/pages/${e(id)}/withdraw`, DocumentSummarySchema, send('POST')),
  collabToken: (id: string) =>
    request(`/api/v1/pages/${e(id)}/collab-token`, CollabTokenResponseSchema, send('POST')),
  snapshot: (id: string) => request(`/api/v1/pages/${e(id)}/snapshot`, VersionSummarySchema, send('POST')),

  // Versions, diffs and review
  listVersions: (pageId: string) => request(`/api/v1/pages/${e(pageId)}/versions`, VersionListSchema),
  getVersion: (id: string) => request(`/api/v1/versions/${e(id)}`, VersionDetailSchema),
  versionDiff: (id: string) => request(`/api/v1/versions/${e(id)}/diff`, BlockDiffSchema),
  pageChanges: (pageId: string) => request(`/api/v1/pages/${e(pageId)}/changes`, BlockDiffSchema),
  compareVersions: (pageId: string, from: number, to: number) =>
    request(`/api/v1/pages/${e(pageId)}/compare?from=${from}&to=${to}`, BlockDiffSchema),
  restoreVersion: (pageId: string, n: number) =>
    request(`/api/v1/pages/${e(pageId)}/versions/${n}/restore`, VersionSummarySchema, send('POST')),
  reviewQueue: (spaceId?: string) =>
    request(`/api/v1/reviews${spaceId ? `?space_id=${e(spaceId)}` : ''}`, ReviewListSchema),
  approveVersion: (id: string, body: ApproveVersionRequest = {}) =>
    request(`/api/v1/versions/${e(id)}/approve`, VersionSummarySchema, send('POST', body)),
  rejectVersion: (id: string, body: RejectVersionRequest) =>
    request(`/api/v1/versions/${e(id)}/reject`, VersionSummarySchema, send('POST', body)),
  retryVersion: (id: string) =>
    request(`/api/v1/versions/${e(id)}/retry`, RetryVersionResponseSchema, send('POST')),

  // Search and ask
  search: (body: SearchRequest) => request('/api/v1/search', SearchResponseSchema, send('POST', body)),
  ask: (body: AskRequest) => request('/api/v1/ask', AskResponseSchema, send('POST', body)),
};
