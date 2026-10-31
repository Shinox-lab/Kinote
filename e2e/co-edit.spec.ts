import { expect, test, type Page } from '@playwright/test';
import { badgeOf, editorOf, expectConnected, PASSWORD, runPageAction, uniqueSuffix } from './support.js';


const CITE = /\(v1, updated \d{4}-\d{2}-\d{2}\)/;

interface Stored {
  token: string;
  tenantId: string;
}

/** The api state of a page as the signed-in page's own session sees it. */
async function pageState(page: Page, pageId: string) {
  const { token, tenantId } = await page.evaluate<Stored>(() => JSON.parse(localStorage.getItem('kinote.session')!));
  const headers = { authorization: `Bearer ${token}`, 'x-tenant-id': tenantId };
  const details = await (await page.request.get(`/api/v1/pages/${pageId}`, { headers })).json();
  const versions: { number: number; status: string }[] = await (await page.request.get(`/api/v1/pages/${pageId}/versions`, { headers })).json();
  return { indexedVersion: details.indexedVersion as { number: number } | null, latest: versions[0] };
}

/** Signs the visitor up through the form; lands on the page the form redirects to. */
async function signUp(page: Page, name: string, email: string, redirect?: string): Promise<void> {
  await page.goto(redirect ? `/sign-up?redirect=${encodeURIComponent(redirect)}` : '/sign-up');
  await page.getByLabel('Name').fill(name);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
}

/** Creates an invitation on the Members screen and returns its accept link. */
async function invite(admin: Page, slug: string, email: string): Promise<string> {
  await admin.goto(`/w/${slug}/admin/members`);
  await admin.getByRole('button', { name: 'Invite someone' }).click();
  await admin.getByLabel('Email').fill(email);
  await admin.getByRole('button', { name: 'Create link' }).click();
  const link = admin.getByLabel('Accept link');
  await expect(link).toHaveValue(/\/accept-invite\//);
  return link.inputValue();
}

/** The invitee opens the accept link signed out, signs up on the way and joins. */
async function acceptInvite(page: Page, name: string, email: string, link: string, slug: string): Promise<void> {
  await page.goto(link);
  // Signed out, the link leads to sign-in; "Create an account" keeps the way back to the invitation.
  await page.getByRole('link', { name: 'Create an account' }).click();
  await page.getByLabel('Name').fill(name);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByRole('button', { name: 'Join the workspace' }).click();
  await page.waitForURL(`**/w/${slug}`);
}

test('two editors and a reviewer: co-edit, hold until approval, index, cite v1', async ({ browser }) => {
  const suffix = uniqueSuffix();
  const slug = `acme-${suffix}`;
  const emails = { a: `ada-${suffix}@example.test`, b: `bea-${suffix}@example.test`, r: `rae-${suffix}@example.test` };
  const text = { a: 'Alpha edit by Ada', b: 'Beta edit by Bea' };

  const [a, b, r] = await Promise.all(
    [0, 1, 2].map(async () => (await browser.newContext()).newPage())
  );

  await test.step('A signs up, creates the workspace and a review-required space', async () => {
    await signUp(a, 'Ada', emails.a);
    await a.getByLabel('Workspace name').fill(`Acme ${suffix}`);
    await expect(a.getByLabel('URL slug')).toHaveValue(slug);
    await a.getByRole('button', { name: 'Create workspace' }).click();
    await a.waitForURL(`**/w/${slug}`);

    await a.goto(`/w/${slug}/admin/spaces`);
    await a.getByRole('button', { name: 'New space' }).click();
    const form = a.locator('form').filter({ has: a.getByRole('heading', { name: 'Create a space' }) });
    await form.getByLabel('Name').fill('Docs');
    await form.getByLabel('Changes need review').check();
    await form.getByRole('button', { name: 'Create space' }).click();
    await expect(a.getByRole('region', { name: 'Settings for Docs' })).toBeVisible();
  });

  await test.step('A invites B and R; they accept in their own contexts', async () => {
    const linkB = await invite(a, slug, emails.b);
    const linkR = await invite(a, slug, emails.r);
    await acceptInvite(b, 'Bea', emails.b, linkB, slug);
    await acceptInvite(r, 'Rae', emails.r, linkR, slug);
  });

  await test.step('A grants B editor and R reviewer on Docs', async () => {
    // A fresh load: the member list is read again, so B and R are in it.
    await a.goto(`/w/${slug}/admin/spaces`);
    await a.getByRole('list', { name: 'Spaces' }).getByRole('button', { name: /^Docs/ }).click();
    const docs = a.getByRole('region', { name: 'Settings for Docs' });
    await docs.getByRole('button', { name: 'Manage access' }).click();
    for (const [name, email, role] of [['Bea', emails.b, 'editor'], ['Rae', emails.r, 'reviewer']] as const) {
      await docs.getByRole('combobox', { name: 'Person or group' }).fill(name);
      await docs.getByRole('option', { name: new RegExp(`^${name}`) }).click();
      await docs.getByLabel('Role', { exact: true }).selectOption(role);
      await docs.getByRole('button', { name: 'Grant access' }).click();
      await expect(docs.getByRole('listitem').filter({ hasText: email })).toBeVisible();
    }
  });

  let pageId = '';
  await test.step('a decoy page in the Inbox is indexed, so that search has something to return', async () => {
    // The tenant's search is not lexical: with nothing indexed an empty result would prove nothing.
    await a.goto(`/w/${slug}/s/inbox`);
    await a.getByLabel('Title', { exact: true }).fill('Holiday calendar');
    await a.getByRole('button', { name: 'Create page' }).click();
    await a.waitForURL(/\/p\/[0-9a-f-]{36}$/);
    await expectConnected(a);
    await editorOf(a).click();
    await a.keyboard.type('Public holidays follow the national calendar.');
    await runPageAction(a, 'Index now');
    await expect(async () => {
      await a.reload();
      await expect(badgeOf(a)).toHaveText('Indexed · v1', { timeout: 2_000 });
    }).toPass({ timeout: 30_000 });
  });

  await test.step('A and B type into the same page at the same time', async () => {
    await a.goto(`/w/${slug}/s/docs`);
    await a.getByLabel('Title', { exact: true }).fill('Leave policy');
    await a.getByRole('button', { name: 'Create page' }).click();
    await a.waitForURL(/\/p\/[0-9a-f-]{36}$/);
    pageId = a.url().split('/p/')[1]!;
    await expectConnected(a);

    await b.goto(`/w/${slug}/p/${pageId}`);
    await expectConnected(b);
    await expect(a.getByTitle('Bea')).toBeVisible();
    await expect(b.getByTitle('Ada')).toBeVisible();

    // A first block both can see, then each types in a block of their own, key by key, together.
    await editorOf(a).click();
    await a.keyboard.type('Shared notes');
    await a.keyboard.press('Enter');
    await expect(editorOf(b)).toContainText('Shared notes');
    await editorOf(b).getByText('Shared notes').click();
    await b.keyboard.press('End');
    await Promise.all([
      a.keyboard.type(text.a, { delay: 25 }),
      b.keyboard.type(` - ${text.b}`, { delay: 25 }),
    ]);

    for (const page of [a, b]) {
      await expect(editorOf(page)).toContainText(text.a);
      await expect(editorOf(page)).toContainText(text.b);
    }
  });

  await test.step('A submits for review: held, not indexed, and A cannot approve', async () => {
    await runPageAction(a, 'Submit for review');
    await expect(badgeOf(a)).toHaveText('Saved · not indexed (awaiting approval)');

    // The submitted version waits in the queue, and A, who wrote it, may not approve it.
    await a.goto(`/w/${slug}/reviews`);
    const item = a.getByRole('list', { name: 'Changes waiting for review' }).getByRole('listitem').filter({ hasText: 'Leave policy' });
    await expect(item).toContainText('Version 1');
    await item.getByRole('button').click();
    const detail = a.getByRole('region', { name: 'Review detail' });
    await expect(detail.getByRole('button', { name: 'Approve' })).toBeDisabled();
    await expect(detail).toContainText('You proposed this change');

    // Held: no version is indexed yet, and the version waits for review.
    const held = await pageState(a, pageId);
    expect(held.indexedVersion).toBeNull();
    expect(held.latest).toMatchObject({ number: 1, status: 'pending_review' });

    // Search and Ask return the decoy but never the held page (by link, not by text).
    // Inside <main> only: the sidebar's page tree links to the held page by design.
    const heldLink = a.getByRole('main').locator(`a[href="/w/${slug}/p/${pageId}"]`);
    await a.goto(`/w/${slug}/search`);
    await a.getByLabel('Search pages and files').fill(text.a);
    await a.getByLabel('Search pages and files').press('Enter');
    const results = a.getByRole('region', { name: 'Search results' });
    await expect(results.getByRole('link', { name: 'Holiday calendar' })).toBeVisible();
    await expect(heldLink).toHaveCount(0);
    await a.getByRole('button', { name: 'Get an answer' }).click();
    await expect(a.getByRole('region', { name: 'Answer' }).getByRole('link', { name: 'Holiday calendar' })).toBeVisible();
    await expect(heldLink).toHaveCount(0);
  });

  await test.step('R approves', async () => {
    await r.goto(`/w/${slug}/reviews`);
    const item = r.getByRole('list', { name: 'Changes waiting for review' }).getByRole('listitem').filter({ hasText: 'Leave policy' });
    await item.getByRole('button').click();
    const detail = r.getByRole('region', { name: 'Review detail' });
    await expect(detail.getByRole('button', { name: 'Approve' })).toBeEnabled();
    await detail.getByRole('button', { name: 'Approve' }).click();
    await expect(r.getByText('Nothing is waiting for your review.')).toBeVisible();
  });

  await test.step('the worker indexes v1; the api, the badge, search and Ask show it', async () => {
    await expect
      .poll(async () => pageState(a, pageId).then((s) => [s.indexedVersion !== null, s.latest?.status]), { timeout: 30_000 })
      .toEqual([true, 'indexed']);
    // The page view only polls while the badge is moving by itself, so look again until the worker is done.
    await expect(async () => {
      await a.goto(`/w/${slug}/p/${pageId}`);
      await expect(badgeOf(a)).toHaveText('Indexed · v1', { timeout: 2_000 });
    }).toPass({ timeout: 30_000 });

    await a.goto(`/w/${slug}/search`);
    await a.getByLabel('Search pages and files').fill(text.a);
    await a.getByLabel('Search pages and files').press('Enter');
    const results = a.getByRole('region', { name: 'Search results' });
    await expect(results.getByRole('link', { name: 'Leave policy' })).toBeVisible();
    await expect(results).toContainText(text.a);
    await expect(results).toContainText('v1');
    // The selector that found nothing while the page was held finds it now,
    // so its count of 0 above was a real absence, not a selector that never matches.
    const indexedLink = a.getByRole('main').locator(`a[href="/w/${slug}/p/${pageId}"]`);
    expect(await indexedLink.count()).toBeGreaterThanOrEqual(1);

    await a.getByRole('button', { name: 'Get an answer' }).click();
    const sources = a.getByRole('region', { name: 'Answer' }).getByRole('list', { name: 'Sources' });
    await expect(sources.getByRole('link', { name: 'Holiday calendar' })).toBeVisible();
    const citation = sources.getByRole('link', { name: 'Leave policy' });
    await expect(citation).toHaveText('Leave policy');
    await citation.click();
    await a.waitForURL(`**/w/${slug}/p/${pageId}`);
    await expect(badgeOf(a)).toHaveText('Indexed · v1');
  });

  for (const page of [a, b, r]) await page.context().close();
});
