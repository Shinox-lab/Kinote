import { expect, test, type Page } from '@playwright/test';
import { addMember, call, createPageInSpace, expectConnected, openAs, runPageAction, searchPassages, seedWorld, type Account, type World } from './support.js';

test.describe.configure({ mode: 'serial' });

let world: World;
let viewer: Account;
let clientsId: string;
let georgeId: string;

test.beforeAll(async ({ playwright }, info) => {
  const request = await playwright.request.newContext({ baseURL: info.project.use.baseURL });
  world = await seedWorld(request, { reviewRequired: false });
  viewer = await addMember(request, world, 'Vic Viewer', 'viewer');
  await request.dispose();
});

const fields = (page: Page) => page.getByRole('region', { name: 'Fields' });

test('turn Clients into a collection, add Status and Launch date; a sub-page fills them; another browser sees them live; Search finds the launch month', async ({
  browser,
  request,
}) => {
  const page = await openAs(browser, world, world.owner);
  clientsId = await createPageInSpace(page, world, 'Clients');

  await page.getByRole('button', { name: 'Page actions' }).first().click();
  await page.getByRole('button', { name: 'Turn into collection' }).click();
  const setup = fields(page);
  await expect(setup.getByText('No fields yet.')).toBeVisible();

  await setup.getByRole('button', { name: '+ Add a field' }).click();
  await setup.getByLabel('Field name').fill('Status');
  await setup.getByLabel('Field type').selectOption('select');
  await setup.getByRole('button', { name: 'Add', exact: true }).click();
  await setup.getByLabel('New choice for Status').fill('Active');
  await setup.getByLabel('New choice for Status').press('Enter');
  await expect(setup.getByText('Active', { exact: true })).toBeVisible();

  await setup.getByRole('button', { name: '+ Add a field' }).click();
  await setup.getByLabel('Field name').fill('Launch date');
  await setup.getByLabel('Field type').selectOption('date');
  await setup.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(setup.getByText('Launch date', { exact: true })).toBeVisible();

  const george = await call<{ id: string }>(request, '/pages', {
    account: world.owner,
    tenantId: world.tenantId,
    method: 'POST',
    data: { space_id: world.spaceId, parent_id: clientsId, title: 'George', slug: `george-${world.suffix}`, markdown: 'George is a client.' },
  });
  georgeId = george.id;

  await page.goto(`/w/${world.slug}/p/${georgeId}`);
  await expectConnected(page);
  const row = fields(page);
  await row.getByRole('button', { name: '2 empty fields' }).click();
  await row.getByRole('group', { name: 'Status' }).getByRole('button', { name: 'Active' }).click();
  await row.getByLabel('Launch date', { exact: true }).fill('2026-12-01');

  const other = await openAs(browser, world, world.owner);
  await other.goto(`/w/${world.slug}/p/${georgeId}`);
  await expectConnected(other);
  await expect(fields(other).getByRole('group', { name: 'Status' }).getByRole('button', { name: 'Active' })).toHaveAttribute('aria-pressed', 'true');
  await expect(fields(other).getByLabel('Launch date', { exact: true })).toHaveValue('2026-12-01');

  await runPageAction(page, 'Index now');
  await expect(async () => {
    const passages = await searchPassages(request, world, world.owner, 'December');
    expect(passages.some((p) => p.includes('Launch date: 2026-12-01 (1 December 2026)'))).toBe(true);
  }).toPass({ timeout: 30_000 });
});

test('a viewer sees values without editors', async ({ browser }) => {
  const page = await openAs(browser, world, viewer);
  await page.goto(`/w/${world.slug}/p/${georgeId}`);
  const row = fields(page);
  await expect(row.getByText('1 December 2026')).toBeVisible();
  await expect(row.getByText('Active', { exact: true })).toBeVisible();
  await expect(row.getByLabel('Launch date', { exact: true })).toHaveCount(0);
});

test('removing a field says how many pages it clears', async ({ browser }) => {
  const page = await openAs(browser, world, world.owner);
  await page.goto(`/w/${world.slug}/p/${clientsId}`);
  const setup = fields(page);
  await setup.getByRole('button', { name: 'Remove Launch date' }).click();
  await expect(setup.getByText('Launch date will be removed from 1 page.')).toBeVisible();
  await setup.getByRole('button', { name: 'Remove field' }).click();
  await expect(setup.getByText('Launch date', { exact: true })).toHaveCount(0);

  await page.goto(`/w/${world.slug}/p/${georgeId}`);
  await expect(fields(page).getByLabel('Launch date', { exact: true })).toHaveCount(0);
});
