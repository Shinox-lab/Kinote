import { test, describe, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from '@living-wiki/db';
import { AppError, ERROR_SENTENCES, ERROR_STATUS } from '@living-wiki/contracts';
import { buildApiServer } from '../src/server.js';

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
  const app = buildApiServer();
  app.get('/__boom', async () => {
    throw new Error('Failed query: select secret');
  });
  app.get('/__missing', async () => {
    throw new AppError('space_not_found');
  });

  beforeEach(async () => {
    await (db as any).__resetForTests();
  });

  test('Zod validation failure answers 400 validation_failed with dotted issue paths', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/tenants',
      payload: {
        name: 'Acme Robotics',
        slug: 'acme-robotics',
        owner_email: 'alice@acme.io',
        owner_name: 'Alice Owner',
      },
    });
    assert.equal(created.statusCode, 201);
    const { tenant, owner } = created.json();

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/spaces',
      headers: {
        'x-tenant-id': tenant.id,
        'x-principal-type': 'user',
        'x-principal-id': owner.id,
        'x-tenant-role': 'owner',
      },
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
