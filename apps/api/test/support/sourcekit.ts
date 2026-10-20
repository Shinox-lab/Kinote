import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { bootstrapTenant, signUpMember } from './testkit.js';
import { uploadRequest } from './multipart.js';

/** A "PDF" the fake extractor reads: one extracted page per given sentence. */
export const pdf = (...pages: string[]) =>
  `%PDF-1.7\nFAKE-EXTRACT\n${JSON.stringify({
    pageCount: pages.length,
    ocrUsed: false,
    sections: pages.map((text, i) => ({ headingPath: [], pageFrom: i + 1, pageTo: i + 1, kind: 'text', text })),
  })}`;

export const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });

/** A tenant with an open space, a review space, an admin, a reviewer and an editor, plus a second tenant. */
export async function sourceWorld(app: FastifyInstance, slug = 'src-world') {
  const { tenant, owner, inboxSpace, headers: ownerHeaders } = await bootstrapTenant(app, { name: `${slug} Co`, slug });
  const mk = async (name: string, review: boolean) => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/spaces', headers: ownerHeaders,
      payload: { name, slug: name.toLowerCase(), review_required: review },
    });
    assert.equal(res.statusCode, 201, res.body);
    return res.json() as { id: string };
  };
  const open = await mk('Open', false);
  const strict = await mk('Strict', true);
  const editor = await signUpMember(app, tenant.id, 'member');
  const reviewer = await signUpMember(app, tenant.id, 'member');
  const viewer = await signUpMember(app, tenant.id, 'member');
  const grant = async (spaceId: string, userId: string, role: string) => {
    const res = await app.inject({
      method: 'POST', url: `/api/v1/spaces/${spaceId}/grants`, headers: ownerHeaders,
      payload: { principal_type: 'user', principal_id: userId, role },
    });
    assert.equal(res.statusCode, 201, res.body);
  };
  for (const space of [open, strict]) {
    await grant(space.id, editor.userId, 'editor');
    await grant(space.id, reviewer.userId, 'reviewer');
    await grant(space.id, viewer.userId, 'viewer');
  }
  return { tenant, owner, ownerHeaders, inboxSpace, open, strict, editor, reviewer, viewer };
}
export type SourceWorld = Awaited<ReturnType<typeof sourceWorld>>;

/** A source with one token, made through the admin routes. */
export async function makeSource(
  app: FastifyInstance,
  adminHeaders: Record<string, string>,
  o: { name: string; spaceId: string; trusted?: boolean }
) {
  const created = await app.inject({
    method: 'POST', url: '/api/v1/sources', headers: adminHeaders,
    payload: { name: o.name, target_space_id: o.spaceId },
  });
  assert.equal(created.statusCode, 201, created.body);
  const source = created.json() as { id: string };
  if (o.trusted) {
    const res = await app.inject({ method: 'PATCH', url: `/api/v1/sources/${source.id}`, headers: adminHeaders, payload: { trusted: true } });
    assert.equal(res.statusCode, 200, res.body);
  }
  const issued = await app.inject({ method: 'POST', url: `/api/v1/sources/${source.id}/tokens`, headers: adminHeaders, payload: { name: 'test' } });
  assert.equal(issued.statusCode, 201, issued.body);
  const { token, info } = issued.json() as { token: string; info: { id: string } };
  return { id: source.id, token, tokenId: info.id };
}

export const putFile = (
  app: FastifyInstance,
  token: string,
  externalId: string,
  file: { name: string; data: Uint8Array | string } | null
) =>
  app.inject({
    ...uploadRequest(`/api/v1/source/files/${encodeURIComponent(externalId)}`, bearer(token), file),
    method: 'PUT',
  });

export const deleteFile = (app: FastifyInstance, token: string, externalId: string) =>
  app.inject({ method: 'DELETE', url: `/api/v1/source/files/${encodeURIComponent(externalId)}`, headers: bearer(token) });
