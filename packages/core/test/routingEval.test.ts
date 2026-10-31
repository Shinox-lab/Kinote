import { beforeAll, expect, it } from 'vitest';
import { createTestDb } from '@kinote/db/testing';
import { DeterministicEmbeddingProvider, DeterministicPlacementModel } from '../src/index.js';
import { runRoutingEval } from '../eval/routing/runEval.js';

beforeAll(async () => {
  const db = await createTestDb();
  await db.reset();
});

it('the deterministic model meets the bar on the fixture', async () => {
  const result = await runRoutingEval(new DeterministicPlacementModel(), new DeterministicEmbeddingProvider());
  // The stand-in replaces on "moved"; the page says nothing about offices, so the label is an insert.
  expect(result.misses.map((m) => [m.cause, m.capture])).toEqual([['model', 'Priya Shah moved to the London office.']]);
  expect(result.causes.retrieval + result.causes.engine).toBe(0);
  expect(result.extraFacts).toBe(0);
  expect(result.removalsAsReplace).toBe(0);
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
