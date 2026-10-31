import type { APIRequestContext } from '@playwright/test';
import type { ClipName } from '../../.vitepress/theme/features';
import { seedDemo as seed, type Demo, type SeedOptions } from '../../../packages/core/src/demo/seed';
import { playwrightHttp } from './http';

export type { Demo, SeedInto, SeedOptions } from '../../../packages/core/src/demo/seed';

/** Who each clip is signed in as, in the order of its views. */
export function accountsFor(clip: ClipName): Array<keyof Demo['people']> {
  if (clip === 'co-edit') return ['priya', 'tomas'];
  if (clip === 'review') return ['jonah', 'mei'];
  return ['priya'];
}

/** The Northwind Studio content on a stack running at the request context's baseURL. */
export function seedDemo(request: APIRequestContext, o: SeedOptions = {}): Promise<Demo> {
  return seed(playwrightHttp(request), o);
}
