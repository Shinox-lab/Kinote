import { expect, test } from '@playwright/test';
import { PASSWORD, openAs, seedWorld } from './support.js';

const NEW_PASSWORD = 'a-different-long-password';

test('change the password from Account and security, then sign out everywhere', async ({ browser, request }) => {
  const world = await seedWorld(request, { reviewRequired: false });
  const page = await openAs(browser, world, world.owner);
  await page.goto(`/w/${world.slug}`);

  await page.getByRole('button', { name: 'Account', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Account and security' }).click();
  await expect(page.getByRole('heading', { name: 'Account and security' })).toBeVisible();

  // The wrong current password is refused; the right one changes it.
  await page.getByLabel('Current password').fill('not-the-password');
  await page.getByLabel('New password').fill(NEW_PASSWORD);
  await page.getByRole('button', { name: 'Change password' }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await page.getByLabel('Current password').fill(PASSWORD);
  await page.getByLabel('New password').fill(NEW_PASSWORD);
  await page.getByRole('button', { name: 'Change password' }).click();
  await expect(page.getByRole('status')).toHaveText(/Password changed/);

  const old = await request.post('/api/v1/auth/sign-in', { data: { email: world.owner.user.email, password: PASSWORD } });
  expect(old.status()).toBe(401);
  const fresh = await request.post('/api/v1/auth/sign-in', { data: { email: world.owner.user.email, password: NEW_PASSWORD } });
  expect(fresh.status()).toBe(200);
  const other = (await fresh.json()).session.token as string;

  await page.getByRole('button', { name: 'Sign out everywhere' }).click();
  await page.waitForURL('**/sign-in');
  const me = await request.get('/api/v1/me', { headers: { authorization: `Bearer ${other}` } });
  expect(me.status()).toBe(401);
});
