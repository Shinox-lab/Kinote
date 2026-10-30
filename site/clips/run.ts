// pnpm clips [name...]: seeds a fresh demo workspace on the running stack, records each clip from the real app, and
// encodes it into site/public/clips (MP4 + poster) and docs/assets/clips (README GIFs). See the site's contributing docs.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, request as playwrightRequest, type APIRequestContext, type Page } from '@playwright/test';
import { encodeClip } from './lib/encode';
import { installCursor } from './lib/cursor';
import { Recorder } from './lib/recorder';
import { framesAt, type Timeline } from './lib/timeline';
import type { Clip, ClipName, ClipRun } from './lib/types';
import { accountsFor, seedDemo, type Demo } from './seed/seed';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const ORDER: ClipName[] = ['capture', 'co-edit', 'review', 'files', 'ask', 'collections', 'drawings', 'links'];
const FPS = 30;
const WORK = join(here, '.work');
const OUT = join(root, 'site', 'public', 'clips');
const GIFS = join(root, 'docs', 'assets', 'clips');

function readEnv(): Record<string, string> {
  const file = join(root, '.env');
  if (!existsSync(file)) return {};
  return Object.fromEntries(
    readFileSync(file, 'utf8')
      .split('\n')
      .map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/))
      .filter((m): m is RegExpMatchArray => m !== null)
      .map((m) => [m[1], m[2].trim()]),
  );
}

function fail(message: string): never {
  console.error(`clips: ${message}`);
  process.exit(1);
}

async function loadClip(arg: string): Promise<Clip> {
  const file = arg.endsWith('.ts') ? resolve(arg) : join(here, `${arg}.clip.ts`);
  if (!existsSync(file)) fail(`no clip "${arg}" (expected ${file})`);
  return ((await import(pathToFileURL(file).href)) as { default: Clip }).default;
}

async function stackAnswers(request: APIRequestContext): Promise<boolean> {
  try {
    await request.get('/api/v1/me', { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

const BACKLOG_SQL =
  "select count(*) from jobs where status in ('queued', 'running') and queue in ('version.index', 'version.card', 'version.entities')";

/**
 * Waits until the worker has indexed and summarised every page, because routing reads those summaries and a capture's
 * job queues behind them. Reads the job table through the compose stack's own Postgres; without it, waits a fixed time.
 */
async function waitForWorker(): Promise<void> {
  const backlog = (): number | null => {
    try {
      const out = execFileSync('docker', ['compose', 'exec', '-T', 'postgres', 'psql', '-U', 'postgres', '-d', 'kinote', '-tAc', BACKLOG_SQL], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      return Number(out.trim());
    } catch {
      return null;
    }
  };
  const deadline = Date.now() + 20 * 60_000;
  for (let left = backlog(); left !== 0; left = backlog()) {
    if (left === null) {
      console.log('clips: cannot read the job queue; waiting 3 minutes for the worker instead');
      await new Promise((r) => setTimeout(r, 180_000));
      return;
    }
    if (Date.now() > deadline) fail(`the worker still has ${left} indexing jobs after 20 minutes`);
    console.log(`clips: waiting for the worker (${left} jobs left)`);
    await new Promise((r) => setTimeout(r, 15_000));
  }
}

async function main(): Promise<void> {
  const env = { ...readEnv(), ...process.env } as Record<string, string | undefined>;
  const baseURL = env.CLIPS_BASE_URL ?? `http://127.0.0.1:${env.WEB_HOST_PORT ?? '8081'}`;
  const args = process.argv.slice(2);
  const clips = await Promise.all((args.length ? args : ORDER).map(loadClip));

  const request = await playwrightRequest.newContext({ baseURL });
  if (!(await stackAnswers(request))) fail(`nothing answers at ${baseURL}. Start the stack first: docker compose up -d`);

  const stand = ['ROUTER_PROVIDER', 'ASK_PROVIDER', 'EMBEDDING_PROVIDER'].filter((k) => (env[k] ?? 'deterministic') === 'deterministic');
  if (stand.length && env.CLIPS_ALLOW_DETERMINISTIC !== '1') {
    fail(`${stand.join(', ')} ${stand.length === 1 ? 'is' : 'are'} deterministic. Clips need the real models; set CLIPS_ALLOW_DETERMINISTIC=1 only for a dry run.`);
  }

  // CLIPS_REUSE_DEMO=1 records into the last seeded workspace, for iterating on one clip.
  const demoFile = join(WORK, 'demo.json');
  const demo: Demo =
    env.CLIPS_REUSE_DEMO === '1' && existsSync(demoFile) ? JSON.parse(readFileSync(demoFile, 'utf8')) : await seedDemo(request);
  writeFileSync(demoFile, JSON.stringify(demo));
  await waitForWorker();

  // One browser per view: two pages in one browser share focus, and the one in the background loses its caret.
  const browsers = [await chromium.launch(), await chromium.launch()];
  const results: Array<{ name: string; seconds: number; mp4: number; gif?: number }> = [];
  try {
    for (const clip of clips) {
      console.log(`clips: recording ${clip.name}`);
      const accounts = accountsFor(clip.name);
      const views = clip.layout === 'side-by-side' ? accounts.slice(0, 2) : accounts.slice(0, 1);
      const pages: Page[] = [];
      for (const [i, who] of views.entries()) {
        const context = await browsers[i].newContext({
          baseURL,
          viewport: clip.viewport,
          deviceScaleFactor: 1.5,
          colorScheme: 'light',
          reducedMotion: 'no-preference',
        });
        const account = demo.people[who];
        await context.addInitScript(
          (s) => {
            localStorage.setItem('kinote.session', JSON.stringify(s.session));
            localStorage.setItem('lw-theme', 'light');
          },
          { session: { token: account.token, user: account.user, tenantId: demo.tenantId, tenantSlug: demo.slug } },
        );
        await installCursor(context);
        pages.push(await context.newPage());
      }

      const work = join(WORK, clip.name);
      rmSync(work, { recursive: true, force: true });
      const recorders = pages.map((p, i) => new Recorder(p, join(work, `view${i}`)));
      const tl: Timeline = { start: 0, end: 0, cuts: [] };
      const run: ClipRun = {
        demo,
        pages,
        request,
        async start() {
          await Promise.all(recorders.map((r) => r.start()));
          tl.start = Date.now();
        },
        async cut(fn) {
          const t0 = Date.now();
          const value = await fn();
          const t1 = Date.now();
          if (t1 - t0 > 600) tl.cuts.push([t0 + 400, t1 - 200]);
          return value;
        },
        hold: (ms) => pages[0].waitForTimeout(ms),
      };

      await clip.record(run);
      tl.end = Date.now();
      const frames = await Promise.all(recorders.map((r) => r.stop()));
      await Promise.all(pages.map((p) => p.context().close()));
      const sequences = frames.map((f) => framesAt(f, tl, FPS));
      const out = await encodeClip(clip.name, sequences, { fps: FPS, readme: clip.readme, outDir: OUT, gifDir: GIFS, workDir: join(work, 'encode') });
      results.push({ name: clip.name, seconds: out.seconds, mp4: statSync(out.mp4).size, gif: out.gif ? statSync(out.gif).size : undefined });
    }
  } finally {
    await Promise.all(browsers.map((b) => b.close()));
    await request.dispose();
  }

  const mb = (n?: number) => (n === undefined ? '' : `${(n / 1024 / 1024).toFixed(1)} MB`);
  console.log('\nclip           seconds  mp4       gif');
  for (const r of results) {
    const warn = r.seconds < 10 || r.seconds > 25 ? '  <- outside 10–25 s' : '';
    console.log(`${r.name.padEnd(14)} ${r.seconds.toFixed(1).padStart(7)}  ${mb(r.mp4).padEnd(9)} ${mb(r.gif)}${warn}`);
  }
}

await main();
