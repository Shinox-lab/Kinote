import type { APIRequestContext, Page } from '@playwright/test';
import type { ClipName } from '../../.vitepress/theme/features';
import type { Demo } from '../seed/seed';

export type { ClipName };

export interface ClipRun {
  demo: Demo;
  /** One page for `single`, two for `side-by-side`, each signed in as the clip's account (see accountsFor). */
  pages: Page[];
  /** An API context on the stack's base URL. */
  request: APIRequestContext;
  /** Starts recording. Navigate first, so the clip opens on a loaded screen. */
  start(): Promise<void>;
  /** Runs `fn` and leaves its time out of the clip, apart from the first 400 ms and the last 200 ms. */
  cut<T>(fn: () => Promise<T>): Promise<T>;
  hold(ms: number): Promise<void>;
}

export interface Clip {
  name: ClipName;
  /** Also make a GIF for the README. */
  readme: boolean;
  layout: 'single' | 'side-by-side';
  /** Of each view. */
  viewport: { width: number; height: number };
  record(run: ClipRun): Promise<void>;
}
