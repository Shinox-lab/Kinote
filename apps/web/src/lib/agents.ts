import type { Agent, AgentScope } from '@kinote/contracts';

/** Scopes the token form offers: Edit waits until a tool uses it. */
export const OFFERED_SCOPES: readonly AgentScope[] = ['read', 'capture'];

/**
 * Whether Capture is allowed but the agent can edit no space, so every capture would be refused. With `scopes`,
 * for a token about to be issued; without, for the agent's live tokens.
 */
export function captureHasNowhereToFile(agent: Agent, scopes?: readonly AgentScope[], now: Date = new Date()): boolean {
  const capture = scopes
    ? scopes.includes('capture')
    : agent.tokens.some((t) => !t.revokedAt && (!t.expiresAt || new Date(t.expiresAt) > now) && t.scopes.includes('capture'));
  return capture && !agent.grants.some((g) => g.role === 'editor');
}
