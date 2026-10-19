import { expect, test, type Page } from '@playwright/test';
import { badgeOf, editorOf, expectConnected, PASSWORD, uniqueSuffix } from './support.js';

const CITE = /\(v1, updated \d{4}-\d{2}-\d{2}\)/;

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
  await admin.getByLabel('Email').fill(email);
  await admin.getByRole('button', { name: 'Create invite' }).click();
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
    const form = a.locator('section').filter({ has: a.getByRole('heading', { name: 'Create a space' }) });
    await form.getByLabel('Name').fill('Docs');
    await form.getByLabel('Changes need review').check();
    await form.getByRole('button', { name: 'Create space' }).click();
    await expect(a.getByRole('heading', { name: 'Docs', level: 3 })).toBeVisible();
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
    const docs = a.getByRole('listitem').filter({ has: a.getByRole('heading', { name: 'Docs', level: 3 }) });
    await docs.getByRole('button', { name: 'Manage access' }).click();
    for (const [name, email, role] of [['Bea', emails.b, 'editor'], ['Rae', emails.r, 'reviewer']] as const) {
      await docs.getByLabel('Person', { exact: true }).selectOption({ label: `${name} (${email})` });
      await docs.getByLabel('Role', { exact: true }).selectOption(role);
      await docs.getByRole('button', { name: 'Grant access' }).click();
      await expect(docs.getByRole('listitem').filter({ hasText: `${name} (user)` })).toBeVisible();
    }
  });

  let pageId = '';
  await test.step('A and B type into the same page at the same time', async () => {
    await a.goto(`/w/${slug}/s/docs`);
    await a.getByLabel('Title').fill('Leave policy');
    await a.getByRole('button', { name: 'Create page' }).click();
    await a.waitForURL(/\/p\/[0-9a-f-]{36}$/);
    pageId = a.url().split('/p/')[1]!;
    await expectConnected(a);

    await b.goto(`/w/${slug}/p/${pageId}`);
    await expectConnected(b);

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
    await a.getByRole('button', { name: 'Submit for review' }).click();
    await expect(badgeOf(a)).toHaveText('Saved · not indexed (awaiting approval)');

    // The submitted version waits in the queue, and A, who wrote it, may not approve it.
    await a.goto(`/w/${slug}/reviews`);
    const item = a.getByRole('list', { name: 'Changes waiting for review' }).getByRole('listitem').filter({ hasText: 'Leave policy' });
    await expect(item).toContainText('Version 1');
    await expect(item).toContainText('Awaiting review');
    await expect(item.getByRole('button', { name: 'Approve' })).toBeDisabled();
    await expect(item).toContainText("You can't approve this change");

    // Nothing is indexed: A's search finds nothing for the new text.
    await a.goto(`/w/${slug}/search`);
    await a.getByLabel('Search or ask a question').fill(text.a);
    await a.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(a.getByText('No passages matched.')).toBeVisible();
  });

  await test.step('R approves', async () => {
    await r.goto(`/w/${slug}/reviews`);
    const item = r.getByRole('list', { name: 'Changes waiting for review' }).getByRole('listitem').filter({ hasText: 'Leave policy' });
    await expect(item.getByRole('button', { name: 'Approve' })).toBeEnabled();
    await item.getByRole('button', { name: 'Approve' }).click();
    await expect(r.getByText('Nothing is waiting for your review.')).toBeVisible();
  });

  await test.step('the worker indexes v1; the badge, search and Ask cite it', async () => {
    // The page view only polls while the badge is moving by itself, so look again until the worker is done.
    await expect(async () => {
      await a.goto(`/w/${slug}/p/${pageId}`);
      await expect(badgeOf(a)).toHaveText('Indexed · v1', { timeout: 2_000 });
    }).toPass({ timeout: 30_000 });

    await a.goto(`/w/${slug}/search`);
    await a.getByLabel('Search or ask a question').fill(text.a);
    await a.getByRole('button', { name: 'Search', exact: true }).click();
    const results = a.getByRole('region', { name: 'Search results' });
    await expect(results.getByRole('link', { name: 'Leave policy' })).toBeVisible();
    await expect(results).toContainText(text.a);
    await expect(results).toContainText(CITE);

    await a.getByRole('button', { name: 'Ask', exact: true }).click();
    const sources = a.getByRole('list', { name: 'Sources' });
    const citation = sources.getByRole('link').first();
    await expect(citation).toHaveText(new RegExp(`^Leave policy ${CITE.source}$`));
    await citation.click();
    await a.waitForURL(`**/w/${slug}/p/${pageId}`);
    await expect(badgeOf(a)).toHaveText('Indexed · v1');
  });

  for (const page of [a, b, r]) await page.context().close();
});
