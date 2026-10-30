import type { APIRequestContext } from '@playwright/test';
import { call, signUpAccount, uniqueSuffix, type Account } from '../../../e2e/support';
import type { ClipName } from '../../.vitepress/theme/features';
import { pages, people, roadmapFields, spaces, workspace, type PersonKey, type SpaceKey } from './content';

export interface Demo {
  tenantId: string;
  slug: string;
  spaces: Record<SpaceKey, { id: string; slug: string }>;
  people: Record<PersonKey, Account>;
  /** Page ids by content key. */
  pages: Record<string, string>;
}

/** Who each clip is signed in as, in the order of its views. */
export function accountsFor(clip: ClipName): Array<keyof Demo['people']> {
  if (clip === 'co-edit') return ['priya', 'tomas'];
  if (clip === 'review') return ['jonah', 'mei'];
  return ['priya'];
}

const INDEX_TIMEOUT_MS = 6 * 60_000;
/** After every page is indexed, the worker still writes the page cards routing reads. */
const CARDS_GRACE_MS = 30_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function log(message: string): void {
  console.log(`seed: ${message}`);
}

/** An existing workspace to fill instead of making a new one; `owner` must be its owner or an admin. */
export interface SeedInto {
  owner: Account;
  tenantId: string;
  slug: string;
}

/**
 * The Northwind Studio content through the public API: four people, three spaces (Clients with review on), the
 * pages, the Roadmap collection with its fields and values, every page indexed (Clients approved by Mei), and a grace
 * period for the worker's page cards. A new workspace by default; with `into`, an existing one, where `into.owner`
 * stands in for Priya and the other three people are signed up and invited.
 */
export async function seedDemo(request: APIRequestContext, o: { into?: SeedInto } = {}): Promise<Demo> {
  const suffix = uniqueSuffix();
  const who = {} as Record<PersonKey, Account>;
  for (const key of Object.keys(people) as PersonKey[]) {
    who[key] = key === 'priya' && o.into ? o.into.owner : await signUpAccount(request, people[key].name, suffix);
  }
  const owner = who.priya;

  let tenantId: string;
  let slug: string;
  if (o.into) {
    ({ tenantId, slug } = o.into);
  } else {
    slug = `${workspace.slug}-${suffix}`;
    const { tenant } = await call<{ tenant: { id: string } }>(request, '/tenants', {
      account: owner,
      method: 'POST',
      data: { name: workspace.name, slug },
    });
    tenantId = tenant.id;
  }
  const as = (account: Account) => <T>(path: string, method: 'GET' | 'POST' | 'PATCH' = 'GET', data?: unknown) =>
    call<T>(request, path, { account, tenantId, method, data });
  log(`workspace ${slug}`);

  const spaceIds = {} as Demo['spaces'];
  for (const key of Object.keys(spaces) as SpaceKey[]) {
    const { id } = await as(owner)<{ id: string }>('/spaces', 'POST', {
      name: spaces[key].name,
      slug: key,
      review_required: spaces[key].reviewRequired,
    });
    spaceIds[key] = { id, slug: key };
  }

  for (const key of ['tomas', 'mei', 'jonah'] as const) {
    const invite = await as(owner)<{ acceptToken: string }>('/invitations', 'POST', { email: who[key].user.email, role: 'member' });
    await call(request, '/invitations/accept', { account: who[key], method: 'POST', data: { token: invite.acceptToken } });
    for (const space of Object.keys(spaces) as SpaceKey[]) {
      const role = key === 'mei' && space === 'clients' ? 'reviewer' : 'editor';
      await as(owner)(`/spaces/${spaceIds[space].id}/grants`, 'POST', { principal_type: 'user', principal_id: who[key].user.id, role });
    }
  }

  const ids: Record<string, string> = {};
  const authors: Record<string, Account> = {};
  for (const p of pages) {
    const author = who[p.by ?? 'priya'];
    const { id } = await as(author)<{ id: string }>('/pages', 'POST', {
      space_id: spaceIds[p.space].id,
      parent_id: p.parent ? ids[p.parent] : null,
      title: p.title,
      slug: p.key,
      markdown: p.markdown,
    });
    ids[p.key] = id;
    authors[p.key] = author;
    if (p.key === 'roadmap') await as(owner)(`/pages/${id}/collection`, 'POST');
  }
  log(`${pages.length} pages`);

  const roadmap = ids.roadmap;
  const field = (body: unknown) => as(owner)<{ id: string }>(`/collections/${roadmap}/fields`, 'POST', body);
  const status = await field({ name: roadmapFields.status.name, type: 'select', options: { choices: roadmapFields.status.choices } });
  const ownerField = await field({ name: roadmapFields.owner.name, type: 'person' });
  const dates = await field({ name: roadmapFields.dates.name, type: 'date' });
  for (const p of pages.filter((x) => x.row)) {
    const row = p.row!;
    await as(owner)(`/pages/${ids[p.key]}/fields`, 'PATCH', {
      [status.id]: row.status,
      [ownerField.id]: [who[row.owner].user.id],
      [dates.id]: { start: row.start, end: row.end },
    });
  }

  for (const p of pages) await as(authors[p.key])(`/pages/${ids[p.key]}/snapshot`, 'POST', {});
  await approveWaiting(as(who.mei));
  await waitUntilIndexed(as(owner), ids, () => approveWaiting(as(who.mei)));
  log(`indexed; giving the worker ${CARDS_GRACE_MS / 1000}s for page cards`);
  await sleep(CARDS_GRACE_MS);

  return { tenantId, slug, spaces: spaceIds, people: who, pages: ids };
}

type As = <T>(path: string, method?: 'GET' | 'POST' | 'PATCH', data?: unknown) => Promise<T>;

async function approveWaiting(api: As): Promise<void> {
  const queue = await api<{ version: { id: string } }[]>('/reviews');
  for (const item of queue) await api(`/versions/${item.version.id}/approve`, 'POST', {});
}

async function waitUntilIndexed(api: As, ids: Record<string, string>, onWait: () => Promise<void>): Promise<void> {
  const deadline = Date.now() + INDEX_TIMEOUT_MS;
  let waiting = Object.keys(ids);
  while (waiting.length > 0) {
    const badges = await Promise.all(waiting.map(async (key) => [key, (await api<{ badge: string }>(`/pages/${ids[key]}`)).badge] as const));
    waiting = badges.filter(([, badge]) => !badge.startsWith('Indexed')).map(([key]) => key);
    if (waiting.length === 0) return;
    if (Date.now() > deadline) {
      throw new Error(`seed: not indexed after ${INDEX_TIMEOUT_MS / 1000}s: ${badges.filter(([k]) => waiting.includes(k)).map(([k, b]) => `${k} (${b})`).join(', ')}`);
    }
    await onWait();
    await sleep(2000);
  }
}
