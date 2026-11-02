export interface LoadConfig {
  apiUrl: string;
  collabUrl: string;
  /** The largest ramp step: how many workspaces are seeded. */
  workspaces: number;
  editorsPerWorkspace: number;
  pagesPerWorkspace: number;
  /** Workspaces started per step, in order. A flat run is one step. */
  ramp: number[];
  stepSeconds: number;
  holdSeconds: number;
  typingMs: number;
  pingMs: number;
  /** 0 disables the page-read loop. */
  readMs: number;
  /** 0 disables page navigation. Requires at least two pages per workspace. */
  navigateMs: number;
  /** Spread each editor's navigation by up to this many extra milliseconds. */
  navigateJitterMs: number;
  /** How long an editor reads a newly opened page before typing again. */
  navReadMs: number;
  seedConcurrency: number;
  seedOnly: boolean;
  runId: string;
  password: string;
  markdownParagraphs: number;
}

function positiveInt(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function nonNegativeInt(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  return value;
}

function rampOf(raw: string | undefined, workspaces: number): number[] {
  if (raw === undefined || raw.trim() === '') return [workspaces];
  const steps = raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .map((part) => positiveInt('RAMP', part, 0));
  if (steps.length === 0) throw new Error('RAMP must name at least one step');
  for (let i = 1; i < steps.length; i++) {
    if (steps[i]! < steps[i - 1]!) throw new Error('RAMP must be increasing');
  }
  return steps;
}

const trimSlash = (url: string) => url.replace(/\/+$/, '');

/** Reads the harness settings from the environment. `RAMP` wins over `WORKSPACES` when both are set. */
export function parseConfig(env: Record<string, string | undefined>): LoadConfig {
  const workspaces = positiveInt('WORKSPACES', env.WORKSPACES, 10);
  const editorsPerWorkspace = positiveInt('EDITORS', env.EDITORS, 2);
  if (editorsPerWorkspace < 2) throw new Error('EDITORS must be at least 2 (the test needs co-editing)');
  const pagesPerWorkspace = positiveInt('PAGES', env.PAGES, 1);
  const ramp = rampOf(env.RAMP, workspaces);
  const navigateMs = nonNegativeInt('NAVIGATE_MS', env.NAVIGATE_MS, 0);
  if (navigateMs > 0 && pagesPerWorkspace < 2) {
    throw new Error('NAVIGATE_MS needs PAGES >= 2 so an editor has another page to open');
  }
  const navigateJitterMs = nonNegativeInt('NAVIGATE_JITTER_MS', env.NAVIGATE_JITTER_MS, 0);
  return {
    apiUrl: trimSlash(env.API_URL ?? 'http://127.0.0.1:8787'),
    collabUrl: trimSlash(env.COLLAB_URL ?? 'ws://127.0.0.1:1234'),
    workspaces: Math.max(...ramp),
    editorsPerWorkspace,
    pagesPerWorkspace,
    ramp,
    stepSeconds: positiveInt('STEP_SECONDS', env.STEP_SECONDS, 60),
    holdSeconds: positiveInt('HOLD_SECONDS', env.HOLD_SECONDS, 60),
    typingMs: positiveInt('TYPING_MS', env.TYPING_MS, 250),
    pingMs: positiveInt('PING_MS', env.PING_MS, 2000),
    readMs: nonNegativeInt('READ_MS', env.READ_MS, 0),
    navigateMs,
    navigateJitterMs,
    navReadMs: nonNegativeInt('NAV_READ_MS', env.NAV_READ_MS, 5000),
    seedConcurrency: positiveInt('SEED_CONCURRENCY', env.SEED_CONCURRENCY, 5),
    seedOnly: env.SEED_ONLY === '1' || env.SEED_ONLY === 'true',
    runId: env.RUN_ID?.trim() || Date.now().toString(36),
    password: env.LOAD_PASSWORD ?? 'correct-horse-battery',
    markdownParagraphs: positiveInt('MARKDOWN_PARAGRAPHS', env.MARKDOWN_PARAGRAPHS, 20),
  };
}
