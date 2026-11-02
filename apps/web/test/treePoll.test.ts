import { describe, expect, test } from 'vitest';
import { TREE_POLL_JITTER_MS, TREE_POLL_MS, treePollInterval } from '../src/lib/poll.js';

describe('treePollInterval', () => {
  test('keeps the base poll and spreads it by the jitter window', () => {
    expect(treePollInterval(() => 0)).toBe(TREE_POLL_MS);
    expect(treePollInterval(() => 0.5)).toBe(TREE_POLL_MS + TREE_POLL_JITTER_MS / 2);
    expect(treePollInterval(() => 0.999999)).toBeLessThan(TREE_POLL_MS + TREE_POLL_JITTER_MS);
  });
});
