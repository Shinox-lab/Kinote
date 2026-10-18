import { describe, expect, it } from 'vitest';
import {
  signCollabToken,
  verifyCollabToken,
  documentName,
  parseDocumentName,
  getCollabTokenSecret,
} from '../src/index.js';

const SECRET = 'a-unit-test-secret-of-at-least-32-chars!';
const TENANT = '11111111-1111-4111-8111-111111111111';
const PAGE = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';
const claims = {
  tenantId: TENANT,
  pageId: PAGE,
  principalType: 'user' as const,
  principalId: USER,
  access: 'write' as const,
};
const NOW = new Date('2026-01-01T00:00:00.000Z');

function b64url(s: string) {
  return Buffer.from(s, 'utf8').toString('base64url');
}

describe('collab tokens', () => {
  it('round-trips claims and sets exp to now + 5 minutes', () => {
    const token = signCollabToken(claims, SECRET, NOW);
    const out = verifyCollabToken(token, SECRET, NOW);
    expect(out).toEqual({ ...claims, exp: Math.floor(NOW.getTime() / 1000) + 300 });
  });

  it('rejects a tampered payload', () => {
    const token = signCollabToken(claims, SECRET, NOW);
    const [, sig] = token.split('.');
    const forged = b64url(JSON.stringify({ ...claims, access: 'write', principalId: 'x', exp: 9999999999 }));
    expect(verifyCollabToken(`${forged}.${sig}`, SECRET, NOW)).toBeNull();
  });

  it('rejects a tampered signature', () => {
    const token = signCollabToken(claims, SECRET, NOW);
    const [payload, sig] = token.split('.');
    const flipped = (sig[0] === 'A' ? 'B' : 'A') + sig.slice(1);
    expect(verifyCollabToken(`${payload}.${flipped}`, SECRET, NOW)).toBeNull();
    expect(verifyCollabToken(`${payload}.${sig}x`, SECRET, NOW)).toBeNull();
    expect(verifyCollabToken(`${payload}.`, SECRET, NOW)).toBeNull();
  });

  it('rejects a token signed with another secret', () => {
    const token = signCollabToken(claims, 'another-secret-that-is-32-chars-long!!', NOW);
    expect(verifyCollabToken(token, SECRET, NOW)).toBeNull();
  });

  it('is valid just before expiry and invalid at and after expiry', () => {
    const token = signCollabToken(claims, SECRET, NOW);
    expect(verifyCollabToken(token, SECRET, new Date(NOW.getTime() + 299_999))).not.toBeNull();
    expect(verifyCollabToken(token, SECRET, new Date(NOW.getTime() + 300_000))).toBeNull();
    expect(verifyCollabToken(token, SECRET, new Date(NOW.getTime() + 600_000))).toBeNull();
  });

  it('rejects malformed tokens', () => {
    for (const bad of [
      '',
      'nodot',
      'a.b.c',
      `user:${USER}:owner`,
      '.',
      `${b64url('not json')}.${b64url('sig')}`,
    ]) {
      expect(verifyCollabToken(bad, SECRET, NOW)).toBeNull();
    }
  });

  it('rejects a correctly signed payload with wrong claim shape', () => {
    // Sign a payload that lacks required fields using the real signer's key by
    // forging through signCollabToken with a bad access value.
    const token = signCollabToken({ ...claims, access: 'admin' as never }, SECRET, NOW);
    expect(verifyCollabToken(token, SECRET, NOW)).toBeNull();
  });
});

describe('document names', () => {
  it('joins and parses tenant and page ids', () => {
    const name = documentName(TENANT, PAGE);
    expect(name).toBe(`${TENANT}:${PAGE}`);
    expect(parseDocumentName(name)).toEqual({ tenantId: TENANT, pageId: PAGE });
  });

  it('rejects anything that is not exactly two UUID segments', () => {
    for (const bad of [
      '',
      TENANT,
      `${TENANT}:`,
      `:${PAGE}`,
      `${TENANT}:${PAGE}:extra`,
      `${TENANT}:not-a-uuid`,
      `not-a-uuid:${PAGE}`,
    ]) {
      expect(parseDocumentName(bad)).toBeNull();
    }
  });
});

describe('getCollabTokenSecret', () => {
  it('throws when unset or shorter than 32 chars', () => {
    const prev = process.env.COLLAB_TOKEN_SECRET;
    try {
      delete process.env.COLLAB_TOKEN_SECRET;
      expect(() => getCollabTokenSecret()).toThrow();
      process.env.COLLAB_TOKEN_SECRET = 'short';
      expect(() => getCollabTokenSecret()).toThrow();
      process.env.COLLAB_TOKEN_SECRET = SECRET;
      expect(getCollabTokenSecret()).toBe(SECRET);
    } finally {
      if (prev === undefined) delete process.env.COLLAB_TOKEN_SECRET;
      else process.env.COLLAB_TOKEN_SECRET = prev;
    }
  });
});
