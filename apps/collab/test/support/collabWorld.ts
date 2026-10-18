import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { and, eq } from 'drizzle-orm';
import { withTenantTx, pages } from '@living-wiki/db';
import {
  signCollabToken,
  getCollabTokenSecret,
  documentName,
  type CollabClaims,
} from '@living-wiki/shared';
import {
  bootstrapTenant,
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

export const AGENT_ID = '00000000-0000-0000-0000-000000000abc';

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
  const pageA = (
    await post(app, headers, '/api/v1/pages', {
      space_id: space.id,
      title: 'Page A',
      slug: 'page-a',
      markdown: '# A',
    })
  ).document;
  const pageB = (
    await post(app, headers, '/api/v1/pages', {
      space_id: space.id,
      title: 'Page B',
      slug: 'page-b',
      markdown: '# B',
    })
  ).document;
  const editor = await signUpMember(app, tenant.id, 'member');
  await post(app, headers, `/api/v1/spaces/${space.id}/grants`, {
    principal_type: 'user',
    principal_id: editor.userId,
    role: 'editor',
  });
  await post(app, headers, `/api/v1/spaces/${space.id}/grants`, {
    principal_type: 'agent',
    principal_id: AGENT_ID,
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
    agentId: AGENT_ID,
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
