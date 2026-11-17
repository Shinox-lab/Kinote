import type { Agent, AgentScope } from '@kinote/contracts';

/** Scopes the token form offers. */
export const OFFERED_SCOPES: readonly AgentScope[] = ['read', 'capture', 'edit'];

/**
 * Which writes go nowhere because the agent can edit no space: every capture would be refused (`capture`), every
 * edit would only be a suggestion (`edit`). With `scopes`, for a token about to be issued; without, for the agent's
 * live tokens.
 */
export function writesHaveNowhereToGo(agent: Agent, scopes?: readonly AgentScope[], now: Date = new Date()): { capture: boolean; edit: boolean } {
  const has = (scope: AgentScope) =>
    scopes
      ? scopes.includes(scope)
      : agent.tokens.some((t) => !t.revokedAt && (!t.expiresAt || new Date(t.expiresAt) > now) && t.scopes.includes(scope));
  const noEditor = !agent.grants.some((g) => g.role === 'editor');
  return { capture: noEditor && has('capture'), edit: noEditor && has('edit') };
}
