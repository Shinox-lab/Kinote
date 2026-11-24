import { describe, expect, it } from 'vitest';
import { signAgentLink, signMediaToken, verifyAgentLink } from '../src/index.js';

const SECRET = 'a-unit-test-secret-of-at-least-32-chars!';
const base = {
  tenantId: 'aaaaaaaa-1111-4111-8111-bbbbbbbbbbbb',
  agentId: 'cccccccc-2222-4222-8222-dddddddddddd',
  tokenId: 'eeeeeeee-3333-4333-8333-ffffffffffff',
};
const file = { ...base, kind: 'file' as const, versionId: '11111111-4444-4444-8444-222222222222' };

describe('agent link tokens', () => {
  it('round-trips the claims and expires 15 minutes later', () => {
    const now = new Date('2026-11-24T10:00:00Z');
    const { token, expiresAt } = signAgentLink('agent-file', file, SECRET, now);
    expect(expiresAt.toISOString()).toBe('2026-11-24T10:15:00.000Z');
    expect(verifyAgentLink('agent-file', token, SECRET, now)).toEqual({ ...file, exp: expiresAt.getTime() / 1000 });
    const page = { ...base, kind: 'page' as const, documentId: file.versionId, versionId: null };
    expect(verifyAgentLink('agent-file', signAgentLink('agent-file', page, SECRET, now).token, SECRET, now)).toMatchObject(page);
    const upload = { ...base, kind: 'upload' as const, uploadId: file.versionId };
    expect(verifyAgentLink('agent-upload', signAgentLink('agent-upload', upload, SECRET, now).token, SECRET, now)).toMatchObject(upload);
  });

  it('refuses an expired token', () => {
    const now = new Date('2026-11-24T10:00:00Z');
    const { token } = signAgentLink('agent-file', file, SECRET, now);
    expect(verifyAgentLink('agent-file', token, SECRET, new Date('2026-11-24T10:15:00Z'))).toBeNull();
  });

  it('refuses a tampered signature or payload', () => {
    const { token } = signAgentLink('agent-file', file, SECRET);
    const [payload, sig] = token.split('.') as [string, string];
    expect(verifyAgentLink('agent-file', `${payload}.${sig.slice(0, -2)}xx`, SECRET)).toBeNull();
    const other = Buffer.from(JSON.stringify({ ...file, versionId: base.tokenId, exp: 9_999_999_999 })).toString('base64url');
    expect(verifyAgentLink('agent-file', `${other}.${sig}`, SECRET)).toBeNull();
    expect(verifyAgentLink('agent-file', token, 'another-secret-of-at-least-32-chars!!')).toBeNull();
  });

  it('a token for one purpose never verifies as another', () => {
    const { token } = signAgentLink('agent-file', file, SECRET);
    expect(verifyAgentLink('agent-upload', token, SECRET)).toBeNull();
    const media = signMediaToken({ tenantId: base.tenantId, versionId: file.versionId, userId: base.agentId }, SECRET).token;
    expect(verifyAgentLink('agent-file', media, SECRET)).toBeNull();
    expect(verifyAgentLink('agent-upload', media, SECRET)).toBeNull();
  });
});
