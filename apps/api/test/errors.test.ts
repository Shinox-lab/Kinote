import { test, describe, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DrizzleQueryError } from 'drizzle-orm';
import { AppError, ErrorCodeSchema, ERROR_SENTENCES, ERROR_STATUS } from '@kinote/contracts';
import { buildTestApp, bootstrapTenant, asUser, signUp, useTestDb } from './support/testkit.js';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...tsFilesUnder(full));
    else if (/\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

describe('error model', () => {
  const app = buildTestApp();
  app.get('/__boom', { config: { auth: 'public' } }, async () => {
    throw new Error('Failed query: select secret');
  });
  app.get('/__missing', { config: { auth: 'public' } }, async () => {
    throw new AppError('space_not_found');
  });

  useTestDb();

  test('Zod validation failure answers 400 validation_failed with dotted issue paths', async () => {
    const { headers } = await bootstrapTenant(app, {
      name: 'Acme Robotics',
      slug: 'acme-robotics',
      email: 'alice@acme.io',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/spaces',
      headers,
      payload: { name: '' },
    });
    assert.equal(res.statusCode, 400);
    const body = res.json();
    assert.equal(body.error, 'validation_failed');
    assert.equal(body.message, ERROR_SENTENCES.validation_failed);
    assert.equal(body.issues[0].path, 'name');
  });

  test('unexpected errors answer 500 internal_error without leaking the cause', async () => {
    const res = await app.inject({ method: 'GET', url: '/__boom' });
    assert.equal(res.statusCode, 500);
    assert.deepEqual(res.json(), {
      error: 'internal_error',
      message: ERROR_SENTENCES.internal_error,
    });
    assert.equal(res.body.includes('Failed query'), false);
  });

  test('an unexpected error is logged (without query params, headers or body) and the reply still leaks nothing', async () => {
    const lines: string[] = [];
    const logged = buildTestApp({
      logger: { level: 'info', stream: { write: (line: string) => void lines.push(line) } },
    });
    logged.post('/__boom', { config: { auth: 'public' } }, async (req) => {
      // Stands in for a careless log line: request headers must be censored.
      req.log.info({ headers: req.headers }, 'headers seen');
      throw new DrizzleQueryError('insert into sessions values ($1)', ['hash-of-sekrit-param'], new Error('boom'));
    });

    const res = await logged.inject({
      method: 'POST',
      url: '/__boom',
      headers: { authorization: 'Bearer sekrit-token', 'x-internal-secret': 'sekrit-internal' },
      payload: { password: 'sekrit-password' },
    });
    await logged.close();

    assert.equal(res.statusCode, 500);
    assert.deepEqual(res.json(), { error: 'internal_error', message: ERROR_SENTENCES.internal_error });
    const entries = lines.map((l) => JSON.parse(l));
    const errorEntry = entries.find((e) => e.level === 50);
    assert.ok(errorEntry, lines.join('\n'));
    assert.equal(errorEntry.msg, 'unexpected error');
    assert.match(errorEntry.err.message, /^Failed query: insert into sessions values \(\$1\)$/);
    assert.match(errorEntry.err.stack, /Failed query/);
    assert.equal(errorEntry.err.cause.message, 'boom');
    const headersEntry = entries.find((e) => e.msg === 'headers seen');
    assert.equal(headersEntry.headers.authorization, '[redacted]');
    assert.equal(headersEntry.headers['x-internal-secret'], '[redacted]');
    const all = lines.join('\n');
    for (const secret of ['sekrit-token', 'sekrit-internal', 'sekrit-password', 'hash-of-sekrit-param']) {
      assert.equal(all.includes(secret), false, secret);
    }
  });

  test('AppError answers its contract status and code', async () => {
    const res = await app.inject({ method: 'GET', url: '/__missing' });
    assert.equal(res.statusCode, 404);
    assert.equal(res.json().error, 'space_not_found');
    assert.equal(res.json().message, ERROR_SENTENCES.space_not_found);
  });

  test('AppError carries code, status from ERROR_STATUS and a default sentence', () => {
    const e = new AppError('forbidden');
    assert.equal(e.code, 'forbidden');
    assert.equal(e.statusCode, ERROR_STATUS.forbidden);
    assert.equal(e.message, ERROR_SENTENCES.forbidden);
    assert.equal(new AppError('forbidden', 'custom').message, 'custom');
  });

  test('malformed JSON body answers 400 validation_failed, not 500', async () => {
    const session = await signUp(app);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/tenants',
      headers: { ...asUser(session), 'content-type': 'application/json' },
      payload: '{not json',
    });
    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.json(), {
      error: 'validation_failed',
      message: ERROR_SENTENCES.validation_failed,
    });
  });

  test('a body-less POST with Content-Type application/json is accepted on routes that take no body', async () => {
    const { headers, owner } = await bootstrapTenant(app, { name: 'Empty Co', slug: 'empty-co' });
    const json = { ...headers, 'content-type': 'application/json' };
    const space = await app.inject({
      method: 'POST',
      url: '/api/v1/spaces',
      headers,
      payload: { name: 'Docs', slug: 'docs' },
    });
    const page = await app.inject({
      method: 'POST',
      url: '/api/v1/pages',
      headers,
      payload: { space_id: space.json().id, title: 'Empty', slug: 'empty', markdown: 'Some text.' },
    });
    const pageId = page.json().id;
    const post = (url: string, h: Record<string, string> = json) =>
      app.inject({ method: 'POST', url, headers: h, payload: '' });

    const collabToken = await post(`/api/v1/pages/${pageId}/collab-token`);
    assert.equal(collabToken.statusCode, 200, collabToken.body);
    const snapshot = await post(`/api/v1/pages/${pageId}/snapshot`);
    assert.equal(snapshot.statusCode, 201, snapshot.body);
    // Answered by the route itself (not a 400 from the body parser).
    const restoreVersion = await post(`/api/v1/pages/${pageId}/versions/1/restore`);
    assert.equal(restoreVersion.statusCode, 409, restoreVersion.body);
    assert.equal(restoreVersion.json().error, 'no_changes');
    const retry = await post(`/api/v1/versions/${snapshot.json().id}/retry`);
    assert.equal(retry.statusCode, 409, retry.body);
    assert.equal(retry.json().error, 'version_not_failed');
    for (const action of ['withdraw', 'archive', 'restore']) {
      const res = await post(`/api/v1/pages/${pageId}/${action}`);
      assert.equal(res.statusCode, 200, `${action}: ${res.body}`);
    }
    const signOut = await post('/api/v1/auth/sign-out', {
      ...asUser(owner),
      'content-type': 'application/json',
    });
    assert.equal(signOut.statusCode, 204, signOut.body);
  });

  test('a malformed or whitespace-only JSON body is still 400; a body over the limit is still 413', async () => {
    const session = await signUp(app);
    for (const payload of ['{not json', ' ', 'null x']) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/tenants',
        headers: { ...asUser(session), 'content-type': 'application/json' },
        payload,
      });
      assert.equal(res.statusCode, 400, JSON.stringify(payload));
      assert.equal(res.json().error, 'validation_failed');
    }
    const huge = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ email: 'a@b.c', password: 'x'.repeat(1_100_000) }),
    });
    assert.equal(huge.statusCode, 413);
  });

  test('a prototype-poisoning JSON body is refused', async () => {
    const session = await signUp(app);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/tenants',
      headers: { ...asUser(session), 'content-type': 'application/json' },
      payload: '{"name":"x","slug":"x","__proto__":{"admin":true}}',
    });
    assert.equal(res.statusCode, 400);
  });

  test('an unauthenticated request is refused before its body is parsed', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/spaces',
      headers: { 'content-type': 'application/json' },
      payload: '{not json',
    });
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().error, 'unauthenticated');
  });

  test('unsupported media type answers 415 validation_failed', async () => {
    const session = await signUp(app);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/tenants',
      headers: { ...asUser(session), 'content-type': 'application/x-weird' },
      payload: 'abc',
    });
    assert.equal(res.statusCode, 415);
    assert.equal(res.json().error, 'validation_failed');
  });

  test('ERROR_STATUS is pinned for every code', () => {
    const expected: Record<string, number> = {};
    for (const code of ErrorCodeSchema.options) {
      if (code.endsWith('_not_found')) expected[code] = 404;
    }
    Object.assign(expected, {
      invitation_invalid: 404,
      forbidden: 403,
      unauthenticated: 401,
      invalid_credentials: 401,
      validation_failed: 400,
      capture_too_long: 400,
      comment_too_long: 400,
      field_invalid_value: 400,
      field_limit: 400,
      collection_in_inbox: 400,
      empty_file: 400,
      file_too_large: 413,
      unsupported_file_type: 415,
      file_unreadable: 422,
      file_text_too_large: 422,
      quota_exceeded: 429,
      rate_limited: 429,
      embedding_unavailable: 503,
      search_unavailable: 503,
      llm_unavailable: 503,
      router_unavailable: 503,
      extractor_unavailable: 503,
      source_unavailable: 503,
      internal_error: 500,
    });
    for (const code of [
      'space_name_taken',
      'slug_taken',
      'group_name_taken',
      'email_taken',
      'no_changes',
      'version_not_pending',
      'version_not_failed',
      'self_approval',
      'has_children',
      'parent_cycle',
      'page_archived',
      'space_archived',
      'last_owner',
      'workspace_not_empty',
      'demo_seed_running',
      'not_demo_workspace',
      'block_recently_edited',
      'managed_by_source',
      'whatsapp_not_linked',
      'not_removed',
      'source_name_taken',
      'capture_not_waiting',
      'document_not_waiting',
      'capture_file_in_use',
      'field_name_taken',
      'collection_exists',
      'change_already_undone',
      'suggestion_not_open',
      'fact_not_open',
      'block_changed',
    ]) {
      expected[code] = 409;
    }
    for (const code of ['tenant_not_found', 'principal_not_found', 'parent_not_found']) {
      assert.equal(expected[code], 404);
    }
    assert.deepEqual(
      Object.keys(expected).sort(),
      [...ErrorCodeSchema.options].sort(),
      'every code must be pinned'
    );
    assert.deepEqual(
      Object.fromEntries(ErrorCodeSchema.options.map((c) => [c, ERROR_STATUS[c]])),
      Object.fromEntries(ErrorCodeSchema.options.map((c) => [c, expected[c]]))
    );
  });

  test('source guard: no thrown object literals under apps/*/src or packages/*/src', () => {
    const roots: string[] = [];
    for (const group of ['apps', 'packages']) {
      for (const name of readdirSync(join(repoRoot, group))) {
        const src = join(repoRoot, group, name, 'src');
        try {
          if (statSync(src).isDirectory()) roots.push(src);
        } catch {
          /* no src dir */
        }
      }
    }
    const offenders = roots
      .flatMap(tsFilesUnder)
      .filter((f) => /throw\s*\{/.test(readFileSync(f, 'utf8')));
    assert.deepEqual(offenders, []);
  });
});
