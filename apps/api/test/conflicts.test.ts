import { test, describe, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import { db, mapDbError } from '@living-wiki/db';
import { AppError } from '@living-wiki/contracts';
import { buildTestApp, bootstrapTenant, asUser, signUp } from './support/testkit.js';

describe('unique violations map to contract codes', () => {
  const app = buildTestApp();

  beforeEach(async () => {
    await (db as any).__resetForTests();
  });

  async function bootstrap(slug = 'acme') {
    return bootstrapTenant(app, {
      name: 'Acme Robotics',
      slug,
      email: `owner-${slug}@acme.io`,
    });
  }

  async function makeSpace(headers: Record<string, string>, name: string, slug: string) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/spaces',
      headers,
      payload: { name, slug },
    });
    assert.equal(res.statusCode, 201, res.body);
    return res.json();
  }

  test('creating a tenant twice with the same slug answers 409 slug_taken', async () => {
    await bootstrap('acme');
    const someone = await signUp(app, 'someone@else.io');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/tenants',
      headers: asUser(someone),
      payload: { name: 'Other', slug: 'acme' },
    });
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().error, 'slug_taken');
  });

  test('creating a space with a duplicate name or slug answers 409', async () => {
    const { headers } = await bootstrap();
    await makeSpace(headers, 'Handbook', 'handbook');
    const dupName = await app.inject({
      method: 'POST',
      url: '/api/v1/spaces',
      headers,
      payload: { name: 'Handbook', slug: 'other' },
    });
    assert.equal(dupName.statusCode, 409);
    assert.equal(dupName.json().error, 'space_name_taken');
    const dupSlug = await app.inject({
      method: 'POST',
      url: '/api/v1/spaces',
      headers,
      payload: { name: 'Other', slug: 'handbook' },
    });
    assert.equal(dupSlug.statusCode, 409);
    assert.equal(dupSlug.json().error, 'slug_taken');
  });

  test('renaming a space to an existing name answers 409 space_name_taken', async () => {
    const { headers } = await bootstrap();
    await makeSpace(headers, 'Handbook', 'handbook');
    const second = await makeSpace(headers, 'Runbooks', 'runbooks');
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/spaces/${second.id}`,
      headers,
      payload: { name: 'Handbook' },
    });
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().error, 'space_name_taken');
  });

  test('two pages with the same slug in one space answer 409 slug_taken', async () => {
    const { headers } = await bootstrap();
    const space = await makeSpace(headers, 'Handbook', 'handbook');
    const create = () =>
      app.inject({
        method: 'POST',
        url: '/api/v1/pages',
        headers,
        payload: { space_id: space.id, title: 'Intro', slug: 'intro', markdown: 'hello' },
      });
    const first = await create();
    assert.equal(first.statusCode, 201);
    const second = await create();
    assert.equal(second.statusCode, 409);
    assert.equal(second.json().error, 'slug_taken');
  });

  test('concurrent page creates with the same slug yield exactly one 201 and one 409', async () => {
    const { headers } = await bootstrap();
    const space = await makeSpace(headers, 'Handbook', 'handbook');
    const create = () =>
      app.inject({
        method: 'POST',
        url: '/api/v1/pages',
        headers,
        payload: { space_id: space.id, title: 'Intro', slug: 'intro', markdown: 'hello' },
      });
    const results = await Promise.all([create(), create()]);
    const statuses = results.map((r) => r.statusCode).sort();
    assert.deepEqual(statuses, [201, 409]);
    const loser = results.find((r) => r.statusCode === 409)!;
    assert.equal(loser.json().error, 'slug_taken');
  });

  test('mapDbError maps wrapped and bare 23505 errors by constraint, unknown stays null', () => {
    const pg = (constraint: string) => Object.assign(new Error('dup'), { code: '23505', constraint });
    const table: Array<[string, string]> = [
      ['tenants_slug_unique', 'slug_taken'],
      ['spaces_tenant_name_idx', 'space_name_taken'],
      ['spaces_tenant_slug_idx', 'slug_taken'],
      ['pages_space_slug_idx', 'slug_taken'],
      ['groups_tenant_name_idx', 'group_name_taken'],
      ['users_email_unique', 'email_taken'],
    ];
    for (const [constraint, code] of table) {
      const bare = mapDbError(pg(constraint));
      assert.ok(bare instanceof AppError);
      assert.equal(bare.code, code);
      const wrapped = mapDbError(Object.assign(new Error('Failed query: secret'), { cause: pg(constraint) }));
      assert.ok(wrapped instanceof AppError);
      assert.equal(wrapped.code, code);
    }
    assert.equal(mapDbError(pg('some_other_unique_idx')), null);
    assert.equal(mapDbError(Object.assign(new Error('x'), { code: '23503', constraint: 'tenants_slug_unique' })), null);
    assert.equal(mapDbError(new Error('boom')), null);
    assert.equal(mapDbError(null), null);
    assert.equal(mapDbError('str'), null);
  });
});
