import { describe, test, beforeAll, afterAll, expect } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { ZodType } from 'zod';
import { withTenantTx, pages, versions } from '@kinote/db';
import {
  AuthResponseSchema,
  SessionResponseSchema,
  MeResponseSchema,
  CreateTenantResponseSchema,
  InviteMemberResponseSchema,
  AcceptInvitationResponseSchema,
  SpaceSchema,
  SpaceResponseSchema,
  SpaceListSchema,
  TreeResponseSchema,
  UpsertGrantResponseSchema,
  GrantListSchema,
  MemberSchema,
  MemberListSchema,
  GroupSchema,
  GroupListSchema,
  GroupMemberResponseSchema,
  PageSummarySchema,
  PageDetailsSchema,
  DocumentSummarySchema,
  VersionSummarySchema,
  VersionListSchema,
  VersionDetailSchema,
  BlockDiffSchema,
  CollabTokenResponseSchema,
  ReviewListSchema,
  RetryVersionResponseSchema,
  SearchResponseSchema,
  AskResponseSchema,
} from '@kinote/contracts';
import { collabSettle, type CollabServer } from '../../collab/src/server.js';
import { startCollabServer } from '../../collab/test/support/wsClient.js';
import { runPendingJobsForTenant } from '../../worker/src/runner.js';
import { encodePageYDoc } from '../src/routes/pages.js';
import { parseReply } from '../src/reply.js';
import { InProcessCollabClient } from './support/inProcessCollab.js';
import { buildTestApp, signUp, asUser, TEST_PASSWORD, useTestDb } from './support/testkit.js';

/**
 * One request per route the console uses, each reply parsed with the schema
 * the console parses it with.
 */
describe('reply contracts', () => {
  let server: CollabServer;
  let app: ReturnType<typeof buildTestApp>;

  beforeAll(async () => {
    ({ server } = await startCollabServer(undefined, {
      debounceMs: 60_000,
      maxDebounceMs: 60_000,
    }));
    app = buildTestApp({ collab: new InProcessCollabClient(server) });
    app.get('/__bad-reply', { config: { auth: 'public' } }, async (_req, reply) =>
      reply.send(parseReply(VersionSummarySchema, { id: 'SECRET-VALUE-123', number: 'SECRET-VALUE-456' }))
    );
  });
  useTestDb();
  afterAll(async () => {
    await collabSettle(server);
    await server.server.destroy();
  });

  type Headers = Record<string, string>;

  /** Runs a request, expects `status` and returns the reply parsed with `schema`. */
  async function call<T>(
    schema: ZodType<T>,
    method: 'GET' | 'POST' | 'PATCH',
    url: string,
    headers: Headers,
    payload?: unknown,
    status = 200
  ): Promise<T> {
    const res = await app.inject({ method, url, headers, payload: payload as any });
    expect(res.statusCode, `${method} ${url}: ${res.body}`).toBe(status);
    const parsed = schema.safeParse(res.json());
    expect(parsed.success, `${method} ${url}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true);
    // The reply carries exactly what the schema names.
    expect(res.json()).toEqual(parsed.data);
    return parsed.data as T;
  }

  test('every route the console uses answers what its schema says', async () => {
    // Auth
    const email = 'owner@contracts.test';
    const signedUp = await call(
      AuthResponseSchema,
      'POST',
      '/api/v1/auth/sign-up',
      {},
      { email, name: 'Owner', password: TEST_PASSWORD },
      201
    );
    const signedIn = await call(
      SessionResponseSchema,
      'POST',
      '/api/v1/auth/sign-in',
      {},
      { email, password: TEST_PASSWORD }
    );
    const session = { token: signedIn.session.token };
    await call(MeResponseSchema, 'GET', '/api/v1/me', asUser(session));

    // Tenant, invitation
    const created = await call(
      CreateTenantResponseSchema,
      'POST',
      '/api/v1/tenants',
      asUser(session),
      { name: 'Contracts Co', slug: 'contracts-co' },
      201
    );
    const tenantId = created.tenant.id;
    const headers = asUser(session, tenantId);

    const guest = await signUp(app, 'guest@contracts.test', 'Guest');
    const invite = await call(
      InviteMemberResponseSchema,
      'POST',
      '/api/v1/invitations',
      headers,
      { email: 'guest@contracts.test', role: 'member' },
      201
    );
    await call(
      AcceptInvitationResponseSchema,
      'POST',
      '/api/v1/invitations/accept',
      asUser(guest),
      { token: invite.acceptToken }
    );

    // Spaces
    const space = await call(
      SpaceResponseSchema,
      'POST',
      '/api/v1/spaces',
      headers,
      { name: 'Docs', slug: 'docs', review_required: true, allow_self_approval: true },
      201
    );
    await call(SpaceResponseSchema, 'GET', `/api/v1/spaces/${space.id}`, headers);
    await call(SpaceListSchema, 'GET', '/api/v1/spaces', headers);
    await call(SpaceSchema, 'PATCH', `/api/v1/spaces/${space.id}`, headers, { name: 'Docs 2' });

    // Members, groups, grants
    await call(MemberListSchema, 'GET', '/api/v1/members', headers);
    await call(MemberSchema, 'PATCH', `/api/v1/members/${signedUp.user.id}`, headers, {
      role: 'owner',
    });
    await call(MemberSchema, 'PATCH', `/api/v1/members/${guest.userId}`, headers, {
      role: 'viewer',
    });
    const group = await call(GroupSchema, 'POST', '/api/v1/groups', headers, { name: 'Writers' }, 201);
    await call(GroupListSchema, 'GET', '/api/v1/groups', headers);
    await call(GroupMemberResponseSchema, 'POST', `/api/v1/groups/${group.id}/members`, headers, {
      principal_type: 'user',
      principal_id: guest.userId,
    });
    await call(
      UpsertGrantResponseSchema,
      'POST',
      `/api/v1/spaces/${space.id}/grants`,
      headers,
      { principal_type: 'group', principal_id: group.id, role: 'editor' },
      201
    );
    const grants = await call(GrantListSchema, 'GET', `/api/v1/spaces/${space.id}/grants`, headers);
    expect(grants.map((g) => g.principalName)).toEqual(['Writers']);

    // Pages and versions
    const page = await call(
      PageSummarySchema,
      'POST',
      '/api/v1/pages',
      headers,
      { space_id: space.id, title: 'Handbook', slug: 'handbook', markdown: 'Laptops arrive on day one.' },
      201
    );
    expect(Object.keys(page).sort()).toEqual(['icon', 'id', 'parentId', 'slug', 'spaceId', 'title']);
    await call(TreeResponseSchema, 'GET', `/api/v1/spaces/${space.id}/tree`, headers);
    await call(TreeResponseSchema, 'GET', `/api/v1/spaces/${space.id}/archived`, headers);
    await call(PageDetailsSchema, 'GET', `/api/v1/pages/${page.id}`, headers);
    await call(CollabTokenResponseSchema, 'POST', `/api/v1/pages/${page.id}/collab-token`, headers);

    const v1 = await call(
      VersionSummarySchema,
      'POST',
      `/api/v1/pages/${page.id}/snapshot`,
      headers,
      undefined,
      201
    );
    expect(v1.status).toBe('pending_review');
    const queue = await call(ReviewListSchema, 'GET', '/api/v1/reviews', headers);
    expect(queue.map((i) => i.version.id)).toEqual([v1.id]);
    const approved = await call(
      VersionSummarySchema,
      'POST',
      `/api/v1/versions/${v1.id}/approve`,
      headers,
      {}
    );
    expect(approved.status).toBe('indexing');
    await runPendingJobsForTenant(tenantId);

    await call(SearchResponseSchema, 'POST', '/api/v1/search', headers, { query: 'laptops' });
    const ask = await call(AskResponseSchema, 'POST', '/api/v1/ask', headers, {
      question: 'When do laptops arrive?',
    });
    expect(ask.foundRelevant).toBe(true);

    const state = await encodePageYDoc('Handbook', 'Laptops arrive on day two.');
    await withTenantTx(tenantId, (tx) =>
      tx
        .update(pages)
        .set({ ydocState: state, liveChangedSinceSnapshot: true })
        .where(and(eq(pages.tenantId, tenantId), eq(pages.documentId, page.id)))
    );
    const v2 = await call(
      VersionSummarySchema,
      'POST',
      `/api/v1/pages/${page.id}/snapshot`,
      headers,
      undefined,
      201
    );
    const rejected = await call(
      VersionSummarySchema,
      'POST',
      `/api/v1/versions/${v2.id}/reject`,
      headers,
      { review_note: 'Not yet.' }
    );
    expect(rejected.status).toBe('rejected');

    await call(VersionListSchema, 'GET', `/api/v1/pages/${page.id}/versions`, headers);
    await call(BlockDiffSchema, 'GET', `/api/v1/pages/${page.id}/changes`, headers);
    await call(BlockDiffSchema, 'GET', `/api/v1/pages/${page.id}/compare?from=1&to=2`, headers);
    await call(VersionDetailSchema, 'GET', `/api/v1/versions/${v2.id}`, headers);
    await call(BlockDiffSchema, 'GET', `/api/v1/versions/${v2.id}/diff`, headers);

    const restored = await call(
      VersionSummarySchema,
      'POST',
      `/api/v1/pages/${page.id}/versions/1/restore`,
      headers,
      undefined,
      201
    );
    expect(restored.reason).toBe('restore');
    await withTenantTx(tenantId, (tx) =>
      tx
        .update(versions)
        .set({ status: 'failed', error: 'embedding_unavailable' })
        .where(and(eq(versions.tenantId, tenantId), eq(versions.id, restored.id)))
    );
    await call(
      RetryVersionResponseSchema,
      'POST',
      `/api/v1/versions/${restored.id}/retry`,
      headers
    );

    // Page lifecycle
    const second = await call(
      PageSummarySchema,
      'POST',
      '/api/v1/pages',
      headers,
      { space_id: space.id, title: 'Policies', slug: 'policies', markdown: 'Be kind.' },
      201
    );
    const moved = await call(DocumentSummarySchema, 'POST', `/api/v1/pages/${second.id}/move`, headers, {
      target_space_id: space.id,
      target_parent_id: page.id,
      position: 'a1',
    });
    expect(moved.parentId).toBe(page.id);
    await call(DocumentSummarySchema, 'POST', `/api/v1/pages/${second.id}/withdraw`, headers);
    const archived = await call(
      DocumentSummarySchema,
      'POST',
      `/api/v1/pages/${second.id}/archive`,
      headers
    );
    expect(typeof archived.archivedAt).toBe('string');
    const back = await call(
      DocumentSummarySchema,
      'POST',
      `/api/v1/pages/${second.id}/restore`,
      headers
    );
    expect(back.archivedAt).toBeNull();

    // An empty space can be archived.
    const empty = await call(
      SpaceResponseSchema,
      'POST',
      '/api/v1/spaces',
      headers,
      { name: 'Scratch', slug: 'scratch' },
      201
    );
    const gone = await call(
      SpaceResponseSchema,
      'POST',
      `/api/v1/spaces/${empty.id}/archive`,
      headers
    );
    expect(typeof gone.archivedAt).toBe('string');
  });

  test('createPage never returns the Yjs state or other heavy columns', async () => {
    const owner = await signUp(app);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/tenants',
      headers: asUser(owner),
      payload: { name: 'Lean Co', slug: 'lean-co' },
    });
    const { tenant, inboxSpace } = res.json();
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/pages',
      headers: asUser(owner, tenant.id),
      payload: { space_id: inboxSpace.id, title: 'Lean', slug: 'lean', markdown: 'x' },
    });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.body).not.toMatch(/ydoc/i);
    expect(PageSummarySchema.parse(created.json())).toEqual(created.json());
  });

  test('parseReply returns a matching value and throws a plain Error naming paths, never values', () => {
    const ok = {
      id: '9d3f3c0e-6d2c-4a52-9c83-8f1f7c2b1a11',
      number: 1,
      status: 'indexed',
      reason: 'submit',
      createdByType: 'user',
      createdBy: 'u',
      createdAt: '2026-01-01T00:00:00.000Z',
      reviewedBy: null,
      reviewedAt: null,
      reviewNote: null,
      indexedAt: null,
      error: null,
    };
    expect(parseReply(VersionSummarySchema, ok)).toEqual(ok);

    let thrown: unknown;
    try {
      parseReply(VersionSummarySchema, { ...ok, number: 'SECRET-VALUE-456', status: 'SECRET-STATUS' });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).name).toBe('Error');
    const message = (thrown as Error).message;
    expect(message).toContain('number');
    expect(message).toContain('status');
    expect(message).not.toContain('SECRET');
  });

  test('a reply that fails its schema is a logged 500 with no body leak', async () => {
    const res = await app.inject({ method: 'GET', url: '/__bad-reply' });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toBe('internal_error');
    expect(res.body).not.toContain('SECRET');
  });
});
