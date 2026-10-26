// Scores the configured routing model on the labelled set, in a throwaway
// in-process database: `pnpm routing:eval`. Uses ROUTER_* and EMBEDDING_*
// from the environment (deterministic by default). Exits 1 below the bar.
import { createTestDb } from '@living-wiki/db/testing';
import { loadConfig } from '@living-wiki/shared';
import { createEmbeddingProvider, createPlacementModel } from '../../src/index.js';
import { runRoutingEval } from './runEval.js';

/** The bar a routing model must meet before it routes real captures. */
const MIN_HIT_RATE = 0.9;

// Settings the evaluation never uses still have to parse.
const placeholder = 'routing-eval-placeholder-'.padEnd(40, 'x');
const config = loadConfig({
  DATABASE_URL: 'pglite://routing-eval',
  COLLAB_TOKEN_SECRET: placeholder,
  INTERNAL_SECRET: placeholder,
  ...process.env,
});

const db = await createTestDb();
await db.reset();
const result = await runRoutingEval(createPlacementModel(config), createEmbeddingProvider(config));
console.log(`facts ${result.facts}, placed ${result.placed}, on the right page ${result.hits} (${(result.hitRate * 100).toFixed(1)}%)`);
console.log(`needs a home ${result.needsHome}, wrong removals ${result.wrongRemovals}, duplicates ${result.duplicates}`);
for (const miss of result.misses) console.log(`  miss: "${miss.capture}" [${miss.fact}] expected ${miss.expected}, got ${miss.got}`);
const ok = result.hitRate >= MIN_HIT_RATE && result.wrongRemovals === 0;
console.log(ok ? 'PASS' : `FAIL (needs >= ${MIN_HIT_RATE * 100}% and no wrong removals)`);
process.exit(ok ? 0 : 1);
