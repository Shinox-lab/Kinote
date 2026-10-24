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
  await expect(page.getByRole('status', { name: 'Presence: connected' })).toBeVisible();
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

/** Opens the page's status chip and runs one of its actions (Index now, Submit for review). */
export async function runPageAction(page: Page, name: 'Index now' | 'Submit for review'): Promise<void> {
  await page.getByRole('button', { name: 'Page status and actions' }).click();
  await page.getByRole('dialog', { name: 'Page status and actions' }).getByRole('button', { name, exact: true }).click();
}

/** Types at the end of the document (the cursor goes to the last block first). */
export async function typeAtEnd(page: Page, text: string): Promise<void> {
  await editorOf(page).click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type(text);
}

// --- Files ---------------------------------------------------------------------

export interface TestFile {
  name: string;
  mimeType: string;
  buffer: Buffer;
}

/**
 * A "PDF" the e2e stack's fake extractor can read: a real signature, then the marker line and one
 * page of text per argument (pages are separated by a form feed). `label` makes the bytes unique.
 */
export function fakePdf(name: string, label: string, ...pages: string[]): TestFile {
  const body = `%PDF-1.7\n%${label}\nFAKE-EXTRACT\n${pages.join('\f')}`;
  return { name, mimeType: 'application/pdf', buffer: Buffer.from(body, 'utf8') };
}

/** A plain text or Markdown or CSV file (these are read without the extractor). */
export function textFile(name: string, mimeType: string, text: string): TestFile {
  return { name, mimeType, buffer: Buffer.from(text, 'utf8') };
}

/** The upload panel of the sidebar. */
export function uploadPanel(page: Page): Locator {
  return page.getByRole('region', { name: 'Uploads' });
}

/** Uploads files through the "+" menu of a space row in the sidebar (the space must be listed there). */
export async function uploadThroughMenu(page: Page, spaceName: string, files: TestFile[]): Promise<void> {
  const side = page.getByRole('complementary', { name: 'Sidebar' });
  await side.getByRole('button', { name: new RegExp(`^(Expand|Collapse) ${spaceName}$`) }).hover();
  await side.getByRole('button', { name: `Add to ${spaceName}` }).click();
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    side.getByRole('menuitem', { name: 'Upload file' }).click(),
  ]);
  await chooser.setFiles(files);
}

/** A file through the api, for specs that are not about uploading. Returns its document id. */
export async function uploadViaApi(
  request: APIRequestContext,
  world: World,
  account: Account,
  file: TestFile,
  o: { spaceId?: string } = {}
): Promise<string> {
  const res = await request.fetch('/api/v1/files', {
    method: 'POST',
    headers: { authorization: `Bearer ${account.token}`, 'x-tenant-id': world.tenantId },
    multipart: {
      ...(o.spaceId ? { space_id: o.spaceId } : { space_id: world.spaceId }),
      file: { name: file.name, mimeType: file.mimeType, buffer: file.buffer },
    },
  });
  const text = await res.text();
  if (!res.ok()) throw new Error(`upload ${file.name} -> ${res.status()} ${text}`);
  return (JSON.parse(text) as { document: { id: string } }).document.id;
}

/**
 * A document's row in the sidebar's space tree. Its accessible name is the title, then the status dot's
 * words when it has one ("Q3.pdf Waiting for review"); the upload panel lists the same name after the tree.
 */
export function treeLink(page: Page, name: string): Locator {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return page
    .getByRole('complementary', { name: 'Sidebar' })
    .getByRole('link', { name: new RegExp(`^${escaped}(?:\\s|$)`) })
    .first();
}

/** Approves every version waiting for review that `reviewer` can see; returns how many. */
export async function approveAll(request: APIRequestContext, world: World, reviewer: Account): Promise<number> {
  const queue = await call<{ version: { id: string } }[]>(request, '/reviews', { account: reviewer, tenantId: world.tenantId });
  for (const item of queue) {
    await call(request, `/versions/${item.version.id}/approve`, {
      account: reviewer,
      tenantId: world.tenantId,
      method: 'POST',
      data: {},
    });
  }
  return queue.length;
}

/** The passages a search returns for `query`, as `version number: text`. */
export async function searchPassages(request: APIRequestContext, world: World, account: Account, query: string): Promise<string[]> {
  const res = await call<{ passages: { versionNumber: number; text: string }[] }>(request, '/search', {
    account,
    tenantId: world.tenantId,
    method: 'POST',
    data: { query },
  });
  return res.passages.map((p) => `${p.versionNumber}: ${p.text}`);
}

/** Waits (through the api) until a file's badge is `badge`; the worker reads and indexes files in the background. */
export async function waitForFileBadge(
  request: APIRequestContext,
  world: World,
  account: Account,
  id: string,
  badge: string | RegExp
): Promise<void> {
  await expect
    .poll(async () => (await call<{ badge: string }>(request, `/files/${id}`, { account, tenantId: world.tenantId })).badge, {
      timeout: 30_000,
    })
    .toMatch(typeof badge === 'string' ? new RegExp(`^${badge.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) : badge);
}

/** A 1×1 PNG, then the fake extractor's marker and a line of "text" (the browser ignores bytes after the image). */
export function fakePng(name: string, label: string, text: string): TestFile {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  );
  return { name, mimeType: 'image/png', buffer: Buffer.concat([png, Buffer.from(`\n${label}\nFAKE-EXTRACT\n${text}`, 'utf8')]) };
}

// --- Sources -------------------------------------------------------------------

/** What a script sends: one file into the source's space under an id of its own (the source token is the only credential). */
export async function putAsSource(
  request: APIRequestContext,
  token: string,
  externalId: string,
  file: TestFile
): Promise<{ status: number; body: { created?: boolean; unchanged?: boolean; document?: { id: string } } }> {
  const res = await request.fetch(`/api/v1/source/files/${externalId}`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${token}` },
    multipart: { file: { name: file.name, mimeType: file.mimeType, buffer: file.buffer } },
  });
  const text = await res.text();
  return { status: res.status(), body: text ? JSON.parse(text) : {} };
}

export async function deleteAsSource(request: APIRequestContext, token: string, externalId: string): Promise<number> {
  const res = await request.fetch(`/api/v1/source/files/${externalId}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}` },
  });
  return res.status();
}

/** A source and one token, through the admin api (for specs that are not about the Sources screen). */
export async function makeSource(
  request: APIRequestContext,
  world: World,
  o: { name: string; trusted?: boolean }
): Promise<{ id: string; token: string }> {
  const source = await call<{ id: string }>(request, '/sources', {
    account: world.owner,
    tenantId: world.tenantId,
    method: 'POST',
    data: { name: o.name, target_space_id: world.spaceId },
  });
  if (o.trusted) {
    await call(request, `/sources/${source.id}`, { account: world.owner, tenantId: world.tenantId, method: 'PATCH', data: { trusted: true } });
  }
  const issued = await call<{ token: string }>(request, `/sources/${source.id}/tokens`, {
    account: world.owner,
    tenantId: world.tenantId,
    method: 'POST',
    data: { name: 'e2e' },
  });
  return { id: source.id, token: issued.token };
}

/** Opens a space in the sidebar unless it is open already (the console remembers which ones are). */
export async function expandSpace(page: Page, name: string): Promise<void> {
  const toggle = page.getByRole('complementary', { name: 'Sidebar' }).getByRole('button', { name: new RegExp(`^(Expand|Collapse) ${name}$`) });
  await expect(toggle).toBeVisible();
  if ((await toggle.getAttribute('aria-expanded')) === 'false') await toggle.click();
}
