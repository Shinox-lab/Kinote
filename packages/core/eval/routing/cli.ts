// Scores the configured routing model on the labelled set, in a throwaway
// in-process database: `pnpm routing:eval [--runs N]`. Uses ROUTER_* and
// EMBEDDING_* from the environment (deterministic by default). Every miss is
// put on Kinote (retrieval, engine) or the model (split, shape, model, error).
// Exits 1 below the bar on the mean, or on any Kinote miss.
import { createTestDb } from '@kinote/db/testing';
import { loadConfig } from '@kinote/shared';
import { createEmbeddingProvider, createPlacementModel, type ChatUsage } from '../../src/index.js';
import { KINOTE_CAUSES, runRoutingEval, type MissCause, type RoutingEvalResult } from './runEval.js';

/** The bar a routing model must meet before it routes real captures. */
const MIN_HIT_RATE = 0.9;

const runsArg = process.argv.indexOf('--runs');
const runs = runsArg === -1 ? 1 : Math.max(1, Number(process.argv[runsArg + 1]) || 1);

// Settings the evaluation never uses still have to parse.
const placeholder = 'routing-eval-placeholder-'.padEnd(40, 'x');
const config = loadConfig({
  DATABASE_URL: 'pglite://routing-eval',
  COLLAB_TOKEN_SECRET: placeholder,
  INTERNAL_SECRET: placeholder,
  ...process.env,
});

interface Tally {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  cost: number;
  /** Calls whose answer carried no cost. */
  unpriced: number;
  ms: number;
}
const emptyTally = (): Tally => ({ calls: 0, promptTokens: 0, completionTokens: 0, cost: 0, unpriced: 0, ms: 0 });
const tallies = { seed: emptyTally(), routing: emptyTally() };
let phase: keyof typeof tallies = 'seed';
const onUsage = (u: ChatUsage) => {
  const t = tallies[phase];
  t.calls += 1;
  t.promptTokens += u.promptTokens;
  t.completionTokens += u.completionTokens;
  t.ms += u.ms;
  if (u.cost === null) t.unpriced += 1;
  else t.cost += u.cost;
};

const db = await createTestDb();
await db.reset();
const model = createPlacementModel(config, { onUsage });
const embedder = createEmbeddingProvider(config);
console.log(`router ${model.model}${config.ROUTER_REASONING ? ` (reasoning ${config.ROUTER_REASONING})` : ''}, ${runs} run${runs > 1 ? 's' : ''}`);

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const results: RoutingEvalResult[] = [];
const started = Date.now();
let routingMs = 0;
for (let i = 0; i < runs; i++) {
  phase = 'seed';
  let routingStarted = 0;
  const result = await runRoutingEval(model, embedder, {
    onRoutingStart: () => {
      phase = 'routing';
      routingStarted = Date.now();
    },
  });
  routingMs += Date.now() - routingStarted;
  results.push(result);

  const r = result;
  if (runs > 1) console.log(`\n--- run ${i + 1} ---`);
  console.log(`facts ${r.facts}, on the right page ${r.hits} (${pct(r.hitRate)}), placed ${r.placed}, needs a home ${r.needsHome}`);
  console.log(`wrong removals ${r.wrongRemovals}, removals done as replace ${r.removalsAsReplace}, duplicates ${r.duplicates}, extra facts ${r.extraFacts}`);
  console.log(`documents ${r.documentHits}/${r.documents}, shape misses ${r.shapeMisses}`);
  const causes = (Object.entries(r.causes) as Array<[MissCause, number]>).filter(([, n]) => n > 0);
  console.log(`misses by cause: ${causes.map(([c, n]) => `${c} ${n}${KINOTE_CAUSES.includes(c) ? ' (Kinote)' : ''}`).join(', ') || 'none'}`);
  for (const m of r.misses) {
    console.log(`  [${m.cause}] "${m.capture.split('\n')[0]}" [${m.fact}] expected ${m.expected}, got ${m.got}`);
    console.log(`      ${m.detail}`);
  }
}
const wallMs = Date.now() - started;

const mean = results.reduce((s, r) => s + r.hitRate, 0) / results.length;
const kinoteMisses = results.reduce((s, r) => s + KINOTE_CAUSES.reduce((k, c) => k + r.causes[c], 0), 0);
if (runs > 1) {
  const rates = results.map((r) => r.hitRate);
  console.log(`\nhit rate mean ${pct(mean)}, min ${pct(Math.min(...rates))}, max ${pct(Math.max(...rates))}`);
  // A miss in every run is the model's (or Kinote's) habit; in some runs, noise.
  const seen = new Map<string, number>();
  for (const r of results) {
    for (const key of new Set(r.misses.map((m) => `[${m.cause}] "${m.capture.split('\n')[0]}" [${m.fact}] expected ${m.expected}`))) {
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
  }
  for (const [key, n] of [...seen].sort((a, b) => b[1] - a[1])) console.log(`  ${n}/${runs} ${key}`);
}

const fmt = (t: Tally) =>
  `${t.calls} calls, ${t.promptTokens} in / ${t.completionTokens} out tokens, ` +
  `${t.calls === 0 ? 'no cost' : t.unpriced === t.calls ? 'cost not reported' : `$${t.cost.toFixed(4)}${t.unpriced ? ` (${t.unpriced} calls unpriced)` : ''}`}, ` +
  `avg ${t.calls ? Math.round(t.ms / t.calls) : 0} ms/call`;
console.log(`\nwall ${(wallMs / 1000).toFixed(1)}s, routing ${(routingMs / 1000).toFixed(1)}s (${results[0]!.facts} facts/run)`);
console.log(`routing: ${fmt(tallies.routing)}`);
console.log(`seeding the corpus (page cards, entities): ${fmt(tallies.seed)}`);

const ok =
  mean >= MIN_HIT_RATE &&
  results.every((r) => r.wrongRemovals === 0 && r.shapeMisses === 0) &&
  kinoteMisses === 0;
console.log(
  ok
    ? 'PASS'
    : `FAIL (needs a mean >= ${MIN_HIT_RATE * 100}%, no wrong removals, no shape misses and no Kinote misses; ${kinoteMisses} Kinote misses)`
);
process.exit(ok ? 0 : 1);
