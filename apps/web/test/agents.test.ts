import { describe, expect, test } from 'vitest';
import type { Agent } from '@kinote/contracts';
import { OFFERED_SCOPES, writesHaveNowhereToGo } from '../src/lib/agents.js';

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
  test('writes with no editor space have nowhere to go', () => {
    expect(writesHaveNowhereToGo(agent(['viewer']), ['read', 'capture'])).toEqual({ capture: true, edit: false });
    expect(writesHaveNowhereToGo(agent([]), ['edit'])).toEqual({ capture: false, edit: true });
    expect(writesHaveNowhereToGo(agent(['viewer', 'editor']), ['read', 'capture', 'edit'])).toEqual({ capture: false, edit: false });
    expect(writesHaveNowhereToGo(agent(['viewer']), ['read'])).toEqual({ capture: false, edit: false });
  });

  test('without scopes it looks at the live tokens', () => {
    expect(writesHaveNowhereToGo(agent(['viewer'], [['read', 'capture'], ['edit']]))).toEqual({ capture: true, edit: true });
    expect(writesHaveNowhereToGo(agent(['viewer'], [['read']]))).toEqual({ capture: false, edit: false });
  });

  test('every scope is offered', () => {
    expect(OFFERED_SCOPES).toEqual(['read', 'capture', 'edit']);
  });
});
