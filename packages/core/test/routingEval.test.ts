import { beforeAll, expect, it } from 'vitest';
import { createTestDb } from '@living-wiki/db/testing';
import { DeterministicEmbeddingProvider, DeterministicPlacementModel } from '../src/index.js';
import { runRoutingEval } from '../eval/routing/runEval.js';

beforeAll(async () => {
  const db = await createTestDb();
  await db.reset();
});

it('the deterministic model meets the bar on the fixture', async () => {
  const result = await runRoutingEval(new DeterministicPlacementModel(), new DeterministicEmbeddingProvider());
  expect(result.misses).toEqual([]);
  expect(result.facts).toBeGreaterThanOrEqual(20);
  expect(result.hitRate).toBeGreaterThanOrEqual(0.9);
  expect(result.wrongRemovals).toBe(0);
  expect(result.duplicates).toBe(0);
}, 60_000);

it('documents are placed under their expected parent and updates stay updates', async () => {
  const result = await runRoutingEval(new DeterministicPlacementModel(), new DeterministicEmbeddingProvider());
  expect(result.documents).toBe(3);
  expect(result.documentHits).toBe(3);
  expect(result.shapeMisses).toBe(0);
  expect(result.hitRate).toBeGreaterThanOrEqual(0.9);
  expect(result.wrongRemovals).toBe(0);
}, 60_000);
