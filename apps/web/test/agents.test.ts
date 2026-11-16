import { describe, expect, test } from 'vitest';
import type { Agent } from '@kinote/contracts';
import { captureHasNowhereToFile, OFFERED_SCOPES } from '../src/lib/agents.js';

const agent = (grants: Array<'viewer' | 'editor'>, tokenScopes: Array<Array<'read' | 'capture' | 'edit'>> = []): Agent => ({
  id: '00000000-0000-4000-8000-000000000001',
  name: 'Bot',
  owner: { id: '00000000-0000-4000-8000-000000000002', name: 'Olive', role: 'owner' },
  createdAt: '2026-11-16T00:00:00.000Z',
  disabledAt: null,
  dailyAiLimit: null,
  alwaysReview: true,
  grants: grants.map((role, i) => ({ spaceId: `00000000-0000-4000-8000-00000000001${i}`, spaceName: `S${i}`, role })),
  tokens: tokenScopes.map((scopes, i) => ({
    id: `00000000-0000-4000-8000-00000000002${i}`,
    name: 't',
    createdAt: '2026-11-16T00:00:00.000Z',
    expiresAt: null,
    prefix: 'abcdefgh',
    lastUsedAt: null,
    revokedAt: null,
    scopes,
  })),
});

describe('agents page helpers', () => {
  test('capture with no editor space has nowhere to file', () => {
    expect(captureHasNowhereToFile(agent(['viewer']), ['read', 'capture'])).toBe(true);
    expect(captureHasNowhereToFile(agent([]), ['capture'])).toBe(true);
    expect(captureHasNowhereToFile(agent(['viewer', 'editor']), ['read', 'capture'])).toBe(false);
    expect(captureHasNowhereToFile(agent(['viewer']), ['read'])).toBe(false);
  });

  test('without scopes it looks at the live tokens', () => {
    expect(captureHasNowhereToFile(agent(['viewer'], [['read', 'capture']]))).toBe(true);
    expect(captureHasNowhereToFile(agent(['viewer'], [['read']]))).toBe(false);
  });

  test('Edit is not offered until a tool uses it', () => {
    expect(OFFERED_SCOPES).toEqual(['read', 'capture']);
  });
});
