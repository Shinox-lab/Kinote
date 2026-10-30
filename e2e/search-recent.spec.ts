import { expect, test } from '@playwright/test';
import { call, openAs, seedWorld } from './support.js';

test('an answer survives leaving Search; a recent search comes back with its answer without asking again', async ({ browser, request }) => {
  const world = await seedWorld(request, { reviewRequired: false });
  const as = { account: world.owner, tenantId: world.tenantId };
  const page = await call<{ id: string }>(request, '/pages', {
    ...as,
    method: 'POST',
    data: { space_id: world.spaceId, title: 'Time off', slug: `time-off-${world.suffix}`, markdown: 'New hires get 22 vacation days a year.' },
  });
  await call(request, `/pages/${page.id}/snapshot`, { ...as, method: 'POST', data: {} });
  await expect
    .poll(async () => (await call<{ badge: string }>(request, `/pages/${page.id}`, as)).badge, { timeout: 30_000 })
    .toMatch(/^Indexed/);

  const owner = await openAs(browser, world, world.owner);
  let asks = 0;
  owner.on('request', (r) => {
    if (r.method() === 'POST' && r.url().endsWith('/api/v1/ask')) asks++;
  });

  await owner.goto(`/w/${world.slug}/search`);
  const box = owner.getByLabel('Search pages and files');
  await box.fill('vacation days');
  await box.press('Enter');
  await owner.getByRole('button', { name: 'Get an answer' }).click();
  const answer = owner.getByRole('region', { name: 'Answer' });
  await expect(answer.getByRole('list', { name: 'Sources' }).getByRole('link', { name: 'Time off' })).toBeVisible();
  expect(asks).toBe(1);
  await expect(owner).toHaveURL(/ask=/);

  // Away and back: the answer is still there, and the model was not asked again.
  await owner.getByRole('navigation', { name: 'Workspace' }).getByRole('link', { name: 'Home' }).click();
  await expect(owner.getByRole('heading', { name: /Welcome back/ })).toBeVisible();
  await owner.goBack();
  await expect(answer.getByRole('list', { name: 'Sources' })).toBeVisible();
  expect(asks).toBe(1);

  // The empty Search screen lists it; opening it brings the kept answer back, again without a new request.
  await owner.goto(`/w/${world.slug}/search`);
  const recent = owner.getByRole('region', { name: 'Recent searches' });
  await expect(recent.getByRole('button', { name: /vacation days.*Answered/ })).toBeVisible();
  await recent.getByRole('button', { name: /vacation days/ }).first().click();
  await expect(answer.getByRole('list', { name: 'Sources' })).toBeVisible();
  expect(asks).toBe(1);

  // "Ask again" asks the model afresh.
  await owner.getByRole('button', { name: 'Ask again' }).click();
  await expect.poll(() => asks).toBe(2);

  // A recent search can be removed.
  await owner.goto(`/w/${world.slug}/search`);
  await recent.getByRole('button', { name: 'Remove vacation days from recent searches' }).click();
  await expect(recent).toHaveCount(0);
});
