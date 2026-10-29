import { describe, test } from 'vitest';
import assert from 'node:assert/strict';
import { sha256Hex } from '@kinote/shared';
import { SESSION_TOKEN_PREFIX } from '../src/auth/sessions.js';
import { mintSourceToken, parseSourceToken, SOURCE_TOKEN_PREFIX } from '../src/auth/sourceTokens.js';

const TENANT = '5f0c1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b';

describe('source tokens', () => {
  test('a minted token parses back to its tenant and its stored hash', () => {
    const minted = mintSourceToken(TENANT);
    assert.ok(minted.token.startsWith(SOURCE_TOKEN_PREFIX));
    assert.notEqual(SOURCE_TOKEN_PREFIX, SESSION_TOKEN_PREFIX);
    assert.equal(minted.hash, sha256Hex(minted.token));
    assert.deepEqual(parseSourceToken(minted.token), { tenantId: TENANT, hash: minted.hash });
    assert.equal(minted.prefix.length, 8);
    assert.ok(minted.token.split('.')[1]!.startsWith(minted.prefix));
  });

  test('two tokens for one tenant differ, and the tenant id is lower-cased', () => {
    assert.notEqual(mintSourceToken(TENANT).token, mintSourceToken(TENANT).token);
    const upper = mintSourceToken(TENANT.toUpperCase());
    assert.equal(parseSourceToken(upper.token)?.tenantId, TENANT);
  });

  test('anything that is not exactly a source token parses to null', () => {
    const good = mintSourceToken(TENANT).token;
    const [head, secret] = good.split('.') as [string, string];
    for (const bad of [
      '',
      'lwsrc_x',
      `${SESSION_TOKEN_PREFIX}${'a'.repeat(43)}`,
      `${head.slice(0, -1)}.${secret}`, // 31 hex characters
      `${head}0.${secret}`, // 33 hex characters
      `${head}.${secret.slice(0, 42)}`,
      `${head}.${secret}A`,
      `${head}.${secret.slice(0, 42)}!`,
      `${head}.${secret} `,
      ` ${good}`,
      good.replace('lwsrc_', 'LWSRC_'),
    ]) {
      assert.equal(parseSourceToken(bad), null, JSON.stringify(bad));
    }
  });
});
