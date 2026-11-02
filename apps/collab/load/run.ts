import { parseConfig } from './config.js';
import { VirtualEditor } from './editor.js';
import { LatencyMeter } from './metrics.js';
import { seedAll } from './seed.js';
import { mapLimit, sleep } from './util.js';

async function main(): Promise<void> {
  const config = parseConfig(process.env);
  console.log(
    `[load] run ${config.runId}: ${config.workspaces} workspaces × ${config.editorsPerWorkspace} editors × ` +
      `${config.pagesPerWorkspace} page(s), ramp ${config.ramp.join(' → ')}`
  );
  console.log(`[load] api ${config.apiUrl} · collab ${config.collabUrl}`);
  if (config.navigateMs > 0) {
    const jitter = config.navigateJitterMs > 0 ? ` +0-${config.navigateJitterMs}ms jitter` : '';
    console.log(`[load] navigation every ${config.navigateMs}ms${jitter}, ${config.navReadMs}ms read dwell`);
  }
  if (config.workspaces > 50) {
    console.log('[load] many sign-ups: set AUTH_RATE_LIMIT_MAX high on the api or seeding will wait on 429s');
  }

  const seeded = await seedAll(config, (done, total) => {
    if (done === total || done % 10 === 0) console.log(`[load] seeded ${done}/${total} workspaces`);
  });
  if (config.seedOnly) {
    console.log(`[load] seed only: ${seeded.length} workspaces ready`);
    return;
  }

  const latency = new LatencyMeter();
  const readLatency = new LatencyMeter();
  let loggedErrors = 0;
  const editors: VirtualEditor[] = [];
  for (const workspace of seeded) {
    for (const page of workspace.pages) {
      page.editors.forEach((user, index) => {
        editors.push(
          new VirtualEditor({
            apiUrl: config.apiUrl,
            collabUrl: config.collabUrl,
            tenantId: workspace.tenantId,
            spaceId: page.spaceId,
            pageId: page.pageId,
            user,
            index,
            typingMs: config.typingMs,
            pingMs: config.pingMs,
            readMs: config.readMs,
            navigateMs: config.navigateMs,
            navigateJitterMs: config.navigateJitterMs,
            navReadMs: config.navReadMs,
            onLatency: (ms) => latency.add(ms),
            onReadLatency: (ms) => readLatency.add(ms),
            onError: (error) => {
              if (loggedErrors >= 5) return;
              loggedErrors += 1;
              console.error('[load] editor error:', error instanceof Error ? error.message : error);
            },
          })
        );
      });
    }
  }

  const perWorkspace = config.editorsPerWorkspace * config.pagesPerWorkspace;
  const startedAt = Date.now();
  let started = 0;

  const report = (): void => {
    const stats = editors.map((editor) => editor.stats());
    const edits = stats.reduce((sum, item) => sum + item.edits, 0);
    const reads = stats.reduce((sum, item) => sum + item.reads, 0);
    const navigations = stats.reduce((sum, item) => sum + item.navigations, 0);
    const errors = stats.reduce((sum, item) => sum + item.errors, 0);
    const rtt = latency.stats();
    const read = readLatency.stats();
    const seconds = Math.max(1, (Date.now() - startedAt) / 1000);
    console.log(
      `[load] ${started} editors · ${edits} edits (${(edits / seconds).toFixed(1)}/s) · ${reads} reads · ` +
        `${navigations} navs · ${errors} errors · rtt p50=${rtt.p50}ms p95=${rtt.p95}ms p99=${rtt.p99}ms · ` +
        `read p50=${read.p50}ms p95=${read.p95}ms p99=${read.p99}ms`
    );
  };

  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    console.error(`[load] ${signal}: stopping`);
    for (const editor of editors) editor.stop();
    report();
    process.exit(1);
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  try {
    for (const target of config.ramp) {
      if (stopping) break;
      const end = Math.min(target * perWorkspace, editors.length);
      const batch = editors.slice(started, end);
      console.log(`[load] ramp: ${target} workspaces (${end} editors)`);
      await mapLimit(batch, 20, async (editor) => {
        await editor.connect();
        editor.start();
      });
      started = end;
      await sleep(config.stepSeconds * 1000);
      report();
    }
    if (!stopping) {
      console.log(`[load] hold ${config.holdSeconds}s at ${started} editors`);
      await sleep(config.holdSeconds * 1000);
      report();
    }
  } finally {
    for (const editor of editors) editor.stop();
  }

  const errors = editors.reduce((sum, editor) => sum + editor.stats().errors, 0);
  if (errors > 0) {
    console.error(`[load] finished with ${errors} errors`);
    process.exitCode = 1;
  } else {
    console.log('[load] finished cleanly');
  }
}

main().catch((error: unknown) => {
  console.error('[load] failed:', error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
