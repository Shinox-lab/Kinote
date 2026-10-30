// pnpm clips [name...]: seeds a fresh demo workspace on the running stack, records each clip from the real app, and
// encodes it into site/public/clips (MP4 + poster) and docs/assets/clips (README GIFs). See the site's contributing docs.
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

  const browser = await chromium.launch();
  const results: Array<{ name: string; seconds: number; mp4: number; gif?: number }> = [];
  try {
    for (const clip of clips) {
      console.log(`clips: recording ${clip.name}`);
      const accounts = accountsFor(clip.name);
      const views = clip.layout === 'side-by-side' ? accounts.slice(0, 2) : accounts.slice(0, 1);
      const pages: Page[] = [];
      for (const who of views) {
        const context = await browser.newContext({
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
    await browser.close();
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
