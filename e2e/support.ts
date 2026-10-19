// Shared helpers of the console specs. Accounts and workspaces that a spec is not
// testing are made through the api (fast); everything a spec asserts goes through the UI.
import { expect, type APIRequestContext, type Browser, type Locator, type Page } from '@playwright/test';

export const PASSWORD = 'correct-horse-battery';

export interface Account {
  token: string;
  user: { id: string; name: string; email: string };
}

export interface World {
  /** Makes names, emails and slugs unique per run. */
  suffix: string;
  tenantId: string;
  slug: string;
  spaceId: string;
  spaceSlug: string;
  owner: Account;
}

/** Eight characters, unique per call (the stack keeps data across specs, and across runs on compose). */
export function uniqueSuffix(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}

export async function call<T = unknown>(
  request: APIRequestContext,
  path: string,
  o: { account?: Account; tenantId?: string; method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'; data?: unknown } = {}
): Promise<T> {
  const res = await request.fetch(`/api/v1${path}`, {
    method: o.method ?? 'GET',
    headers: {
      ...(o.account ? { authorization: `Bearer ${o.account.token}` } : {}),
      ...(o.tenantId ? { 'x-tenant-id': o.tenantId } : {}),
    },
    data: o.data,
  });
  const text = await res.text();
  if (!res.ok()) throw new Error(`${o.method ?? 'GET'} ${path} -> ${res.status()} ${text}`);
  return (text ? JSON.parse(text) : null) as T;
}

export async function signUpAccount(request: APIRequestContext, name: string, suffix: string): Promise<Account> {
  const email = `${name.toLowerCase().replace(/\W+/g, '-')}-${suffix}@example.test`;
  const res = await call<{ user: Account['user']; session: { token: string } }>(request, '/auth/sign-up', {
    method: 'POST',
    data: { email, name, password: PASSWORD },
  });
  return { token: res.session.token, user: res.user };
}

/**
 * An owner with a workspace and one space, through the api. `reviewRequired` makes the space
 * hold every snapshot until a reviewer other than its authors approves it.
 */
export async function seedWorld(
  request: APIRequestContext,
  o: { reviewRequired: boolean; ownerName?: string }
): Promise<World> {
  const suffix = uniqueSuffix();
  const owner = await signUpAccount(request, o.ownerName ?? 'Olive Owner', suffix);
  const slug = `acme-${suffix}`;
  const { tenant } = await call<{ tenant: { id: string } }>(request, '/tenants', {
    account: owner,
    method: 'POST',
    data: { name: `Acme ${suffix}`, slug },
  });
  const space = await call<{ id: string }>(request, '/spaces', {
    account: owner,
    tenantId: tenant.id,
    method: 'POST',
    data: { name: 'Docs', slug: 'docs', review_required: o.reviewRequired },
  });
  return { suffix, tenantId: tenant.id, slug, spaceId: space.id, spaceSlug: 'docs', owner };
}

/** A workspace member with a grant on the world's space. */
export async function addMember(
  request: APIRequestContext,
  world: World,
  name: string,
  role: 'viewer' | 'editor' | 'reviewer'
): Promise<Account> {
  const account = await signUpAccount(request, name, world.suffix);
  const invite = await call<{ acceptToken: string }>(request, '/invitations', {
    account: world.owner,
    tenantId: world.tenantId,
    method: 'POST',
    data: { email: account.user.email, role: 'member' },
  });
  await call(request, '/invitations/accept', { account, method: 'POST', data: { token: invite.acceptToken } });
  await call(request, `/spaces/${world.spaceId}/grants`, {
    account: world.owner,
    tenantId: world.tenantId,
    method: 'POST',
    data: { principal_type: 'user', principal_id: account.user.id, role },
  });
  return account;
}

/** A page signed in as `account`, in a context of its own (the console keeps its session in localStorage). */
export async function openAs(browser: Browser, world: World, account: Account): Promise<Page> {
  const context = await browser.newContext();
  const session = {
    token: account.token,
    user: account.user,
    tenantId: world.tenantId,
    tenantSlug: world.slug,
  };
  await context.addInitScript((s) => localStorage.setItem('living-wiki.session', JSON.stringify(s)), session);
  return context.newPage();
}

// --- Screens -------------------------------------------------------------------

/** The live editor of an open page. */
export function editorOf(page: Page): Locator {
  return page.getByRole('textbox').first();
}

export async function expectConnected(page: Page): Promise<void> {
  await expect(page.getByRole('status').filter({ hasText: 'Connected' })).toBeVisible();
}

/** The page's badge, exactly as the server wrote it. */
export function badgeOf(page: Page): Locator {
  return page.getByRole('status', { name: /^Page status:/ });
}

/** Creates a page from the space screen and waits until its editor is live. Returns the page id. */
export async function createPageInSpace(page: Page, world: World, title: string): Promise<string> {
  await page.goto(`/w/${world.slug}/s/${world.spaceSlug}`);
  await page.getByLabel('Title').fill(title);
  await page.getByRole('button', { name: 'Create page' }).click();
  await page.waitForURL(/\/p\/[0-9a-f-]{36}$/);
  await expectConnected(page);
  return page.url().split('/p/')[1]!;
}

/** Types at the end of the document (the cursor goes to the last block first). */
export async function typeAtEnd(page: Page, text: string): Promise<void> {
  await editorOf(page).click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type(text);
}
