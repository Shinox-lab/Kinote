import { describe, expect, test } from 'vitest';
import type { Source, SourceToken } from '@living-wiki/contracts';
import { curlExamples, lastUsedLabel, sourceStatusLabel, tokenState } from '../src/lib/sources.js';

const NOW = new Date('2026-10-20T12:00:00.000Z');
const token = (over: Partial<SourceToken> = {}): SourceToken => ({
  id: '8d1c2b0e-6d2c-4a52-9c83-8f1f7c2b1a55',
  name: 'nightly export',
  prefix: 'abcd1234',
  createdAt: '2026-10-01T00:00:00.000Z',
  lastUsedAt: null,
  expiresAt: null,
  revokedAt: null,
  ...over,
});

describe('curlExamples', () => {
  test('a PUT with a file and a DELETE, for the address the console is served from', () => {
    const out = curlExamples({ apiBase: 'https://wiki.example.com/', token: 'lwsrc_abc.def' });
    expect(out.put).toBe(
      'curl -X PUT -H "Authorization: Bearer lwsrc_abc.def" -F "file=@report.pdf" "https://wiki.example.com/api/v1/source/files/reports/2026-q3"'
    );
    expect(out.delete).toBe(
      'curl -X DELETE -H "Authorization: Bearer lwsrc_abc.def" "https://wiki.example.com/api/v1/source/files/reports/2026-q3"'
    );
  });

  test('the base never keeps a trailing slash, however many', () => {
    expect(curlExamples({ apiBase: 'http://localhost:8787///', token: 't' }).put).toContain('"http://localhost:8787/api/v1/source/files/');
  });

  test('a character the shell would act on inside double quotes is escaped', () => {
    const out = curlExamples({ apiBase: 'https://x.test', token: 'a"b$c`d\\e' });
    expect(out.put).toContain('Bearer a\\"b\\$c\\`d\\\\e"');
  });
});

describe('token state', () => {
  test('active, revoked or expired; a revoked token is revoked even when it has also expired', () => {
    expect(tokenState(token(), NOW)).toBe('active');
    expect(tokenState(token({ revokedAt: '2026-10-10T00:00:00.000Z' }), NOW)).toBe('revoked');
    expect(tokenState(token({ expiresAt: '2026-10-19T00:00:00.000Z' }), NOW)).toBe('expired');
    expect(tokenState(token({ expiresAt: '2026-10-21T00:00:00.000Z' }), NOW)).toBe('active');
    expect(tokenState(token({ expiresAt: '2026-10-19T00:00:00.000Z', revokedAt: '2026-10-10T00:00:00.000Z' }), NOW)).toBe('revoked');
  });

  test('last used reads as a relative time, or "Never used"', () => {
    expect(lastUsedLabel(token(), NOW)).toBe('Never used');
    expect(lastUsedLabel(token({ lastUsedAt: '2026-10-20T09:00:00.000Z' }), NOW)).toBe('Used 3h ago');
    expect(lastUsedLabel(token({ lastUsedAt: '2026-10-20T11:59:30.000Z' }), NOW)).toBe('Used just now');
  });
});

describe('sourceStatusLabel', () => {
  test('active or paused', () => {
    expect(sourceStatusLabel({ status: 'active' } as Pick<Source, 'status'>)).toBe('Active');
    expect(sourceStatusLabel({ status: 'paused' } as Pick<Source, 'status'>)).toBe('Paused');
  });
});
