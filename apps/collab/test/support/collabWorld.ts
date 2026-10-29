import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { and, eq } from 'drizzle-orm';
import { withTenantTx, pages } from '@kinote/db';
import {
  signCollabToken,
  getCollabTokenSecret,
  documentName,
  type CollabClaims,
} from '@kinote/shared';
import {
  bootstrapTenant,
  createAgent,
  signUpMember,
  type buildTestApp,
} from '../../../api/test/support/testkit.js';

type FastifyInstance = ReturnType<typeof buildTestApp>;

export { TEST_INTERNAL_SECRET } from './wsClient.js';

async function post(
  app: FastifyInstance,
  headers: Record<string, string>,
  url: string,
  payload: unknown
) {
  const res = await app.inject({ method: 'POST', url, headers, payload: payload as any });
  assert.equal(res.statusCode, 201, res.body);
  return res.json();
}

/**
 * A tenant with one space, two pages, an editor user and an agent, both granted
 * editor on the space, created through the real API routes.
 */
export async function buildCollabWorld(app: FastifyInstance) {
  const { owner, tenant, headers } = await bootstrapTenant(app, {
    name: 'Origin Co',
    slug: 'origin-co',
  });
  const space = await post(app, headers, '/api/v1/spaces', { name: 'Docs', slug: 'docs' });
  const pageA = await post(app, headers, '/api/v1/pages', {
    space_id: space.id,
    title: 'Page A',
    slug: 'page-a',
    markdown: '# A',
  });
  const pageB = await post(app, headers, '/api/v1/pages', {
    space_id: space.id,
    title: 'Page B',
    slug: 'page-b',
    markdown: '# B',
  });
  const editor = await signUpMember(app, tenant.id, 'member');
  await post(app, headers, `/api/v1/spaces/${space.id}/grants`, {
    principal_type: 'user',
    principal_id: editor.userId,
    role: 'editor',
  });
  // Grants need a real, enabled agent of the tenant.
  const agentId = await createAgent(tenant.id, owner.userId);
  await post(app, headers, `/api/v1/spaces/${space.id}/grants`, {
    principal_type: 'agent',
    principal_id: agentId,
    role: 'editor',
  });

  function token(
    pageId: string,
    principalType: 'user' | 'agent',
    principalId: string,
    access: CollabClaims['access'] = 'write'
  ): string {
    return signCollabToken(
      { tenantId: tenant.id, pageId, principalType, principalId, access },
      getCollabTokenSecret()
    );
  }

  return {
    owner,
    tenant,
    headers,
    space,
    pageA,
    pageB,
    editor,
    agentId,
    docName: (pageId: string) => documentName(tenant.id, pageId),
    token,
  };
}

/** Decodes the page's persisted `pages.ydoc_state` into a fresh Y.Doc. */
export async function storedDoc(tenantId: string, pageId: string): Promise<Y.Doc> {
  const [row] = await withTenantTx(tenantId, (tx) =>
    tx
      .select({ ydocState: pages.ydocState })
      .from(pages)
      .where(and(eq(pages.tenantId, tenantId), eq(pages.documentId, pageId)))
  );
  const doc = new Y.Doc();
  if (row?.ydocState) Y.applyUpdate(doc, new Uint8Array(row.ydocState));
  return doc;
}

/** Polls `fn` until it returns true, failing after `ms`. */
export async function waitFor(fn: () => boolean | Promise<boolean>, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`condition not met within ${ms} ms`);
}

/**
 * A tenant with a review space (`review_required`, no self-approval), one page
 * of three paragraphs, A (reviewer, so A could approve if A had not edited),
 * editors B and C, a reviewer R, a viewer V and an agent granted editor,
 * created through the real API routes.
 */
export async function buildReviewWorld(app: FastifyInstance) {
  const { owner, tenant, headers } = await bootstrapTenant(app, {
    name: 'Review Co',
    slug: 'review-co',
  });
  const space = await post(app, headers, '/api/v1/spaces', {
    name: 'Handbook',
    slug: 'handbook',
    review_required: true,
    allow_self_approval: false,
  });
  const page = await post(app, headers, '/api/v1/pages', {
    space_id: space.id,
    title: 'Handbook',
    slug: 'handbook',
    markdown: 'First paragraph.\n\nSecond paragraph.\n\nThird paragraph.',
  });
  const grant = (principal_type: 'user' | 'agent', principal_id: string, role: string) =>
    post(app, headers, `/api/v1/spaces/${space.id}/grants`, { principal_type, principal_id, role });

  const a = await signUpMember(app, tenant.id, 'member');
  const b = await signUpMember(app, tenant.id, 'member');
  const c = await signUpMember(app, tenant.id, 'member');
  const r = await signUpMember(app, tenant.id, 'member');
  const v = await signUpMember(app, tenant.id, 'member');
  // A may review (and edit): approving a snapshot A typed into must be refused
  // as self-approval, not as a missing role.
  await grant('user', a.userId, 'reviewer');
  await grant('user', b.userId, 'editor');
  await grant('user', c.userId, 'editor');
  await grant('user', r.userId, 'reviewer');
  await grant('user', v.userId, 'viewer');
  const agentId = await createAgent(tenant.id, owner.userId);
  await grant('agent', agentId, 'editor');

  function token(
    principalType: 'user' | 'agent',
    principalId: string,
    access: CollabClaims['access'] = 'write'
  ): string {
    return signCollabToken(
      { tenantId: tenant.id, pageId: page.id, principalType, principalId, access },
      getCollabTokenSecret()
    );
  }

  return {
    owner,
    tenant,
    headers,
    space,
    page,
    a,
    b,
    c,
    r,
    v,
    agentId,
    name: documentName(tenant.id, page.id),
    token,
  };
}
