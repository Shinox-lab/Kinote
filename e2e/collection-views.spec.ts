import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { addMember, call, createPageInSpace, expectConnected, openAs, seedWorld, type Account, type World } from './support.js';

test.describe.configure({ mode: 'serial' });

let world: World;
let viewer: Account;
let clientsId: string;
let statusId: string;

const api = <T>(request: APIRequestContext, path: string, method: 'GET' | 'POST' | 'PATCH' = 'GET', data?: unknown) =>
  call<T>(request, path, { account: world.owner, tenantId: world.tenantId, method, data });

test.beforeAll(async ({ playwright }, info) => {
  const request = await playwright.request.newContext({ baseURL: info.project.use.baseURL });
  world = await seedWorld(request, { reviewRequired: false });
  viewer = await addMember(request, world, 'Vic Viewer', 'viewer');
  const page = (title: string, parentId: string | null, spaceId = world.spaceId) =>
    api<{ id: string }>(request, '/pages', 'POST', {
      space_id: spaceId,
      parent_id: parentId,
      title,
      slug: `${title.toLowerCase().replace(/\W+/g, '-')}-${world.suffix}`,
      markdown: `${title}.`,
    });
  clientsId = (await page('Clients', null)).id;
  await api(request, `/pages/${clientsId}/collection`, 'POST');
  statusId = (
    await api<{ id: string }>(request, `/collections/${clientsId}/fields`, 'POST', {
      name: 'Status',
      type: 'select',
      options: { choices: [{ id: 'lead', name: 'Lead', color: 'gray' }, { id: 'active', name: 'Active', color: 'green' }] },
    })
  ).id;
  const george = (await page('George', clientsId)).id;
  const tavros = (await page('Tavros', clientsId)).id;
  await api(request, `/pages/${george}/fields`, 'PATCH', { [statusId]: 'active' });
  await api(request, `/pages/${tavros}/fields`, 'PATCH', { [statusId]: 'lead' });

  // A collection in a space the viewer can't open.
  const board = await api<{ id: string }>(request, '/spaces', 'POST', { name: 'Board', slug: `board-${world.suffix}` });
  const deals = (await page('Deals', null, board.id)).id;
  await api(request, `/pages/${deals}/collection`, 'POST');
  await request.dispose();
});

const editorBody = (page: Page) => page.locator('.bn-editor').first();
const view = (page: Page) => page.locator('[data-collection-view]').first();

async function insertView(page: Page) {
  await editorBody(page).click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('/collection view');
  await page.getByRole('option', { name: /Collection view/ }).click();
}

test('a view on the collection page: table, + New, a cell edit, a filter, a board drag', async ({ browser, request }) => {
  const page = await openAs(browser, world, world.owner);
  await page.goto(`/w/${world.slug}/p/${clientsId}`);
  await expectConnected(page);
  await insertView(page);

  const table = view(page).getByRole('table');
  await expect(table.getByRole('button', { name: 'George' })).toBeVisible();
  await expect(table.getByRole('button', { name: 'Tavros' })).toBeVisible();

  // Edit a cell: Tavros becomes Active.
  const tavrosRow = table.getByRole('row').filter({ hasText: 'Tavros' });
  await tavrosRow.getByRole('button', { name: 'Edit Status' }).click();
  await tavrosRow.getByRole('group', { name: 'Status' }).getByRole('button', { name: 'Active' }).click();
  await expect(tavrosRow.getByRole('group', { name: 'Status' }).getByRole('button', { name: 'Active' })).toHaveAttribute('aria-pressed', 'true');

  // A filter: Status is Lead (nothing now), then Active (both).
  await view(page).getByRole('button', { name: 'Filter', exact: true }).click();
  await view(page).getByRole('button', { name: '+ Add a filter' }).click();
  await view(page).getByLabel('Filter field').selectOption({ label: 'Status' });
  await view(page).getByLabel('Filter value').selectOption({ label: 'Lead' });
  await expect(view(page).getByText('No pages match these filters.')).toBeVisible();
  await view(page).getByLabel('Filter value').selectOption({ label: 'Active' });
  await expect(table.getByRole('button', { name: 'George' })).toBeVisible();
  await expect(table.getByRole('button', { name: 'Tavros' })).toBeVisible();
  await view(page).getByRole('button', { name: 'Remove filter' }).click();

  // Typing in a view's text box stays in the box: Backspace edits the filter, not the page.
  await view(page).getByRole('button', { name: '+ Add a filter' }).click();
  const titleFilter = view(page).getByLabel('Filter value');
  await titleFilter.click();
  await page.keyboard.type('Geox');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Enter');
  await expect(titleFilter).toHaveValue('Geo');
  await expect(table.getByRole('button', { name: 'George' })).toBeVisible();
  await expect(table.getByRole('button', { name: 'Tavros' })).toHaveCount(0);
  await view(page).getByRole('button', { name: 'Remove filter' }).click();
  await view(page).getByRole('button', { name: 'Filter', exact: true }).click();

  // + New: a sub-page opens in the side panel.
  await view(page).getByRole('button', { name: '+ New' }).click();
  await expect(table.getByRole('button', { name: 'Untitled' })).toBeVisible();
  await expect(page).toHaveURL(/peek=/);
  await page.getByRole('complementary', { name: 'Page preview' }).getByRole('button', { name: 'Close' }).click();

  // A board grouped by Status: drag George to Lead.
  await view(page).getByLabel('Add a view').selectOption('board');
  const lead = view(page).getByRole('region', { name: 'Lead' });
  const active = view(page).getByRole('region', { name: 'Active' });
  await expect(active.getByRole('article', { name: 'George' })).toBeVisible();
  await active.getByRole('article', { name: 'George' }).dragTo(lead);
  await expect(lead.getByRole('article', { name: 'George' })).toBeVisible();
  // The View panel follows the tab: its name box never carries another view's name over.
  await view(page).getByRole('button', { name: 'View', exact: true }).click();
  await expect(view(page).getByLabel('View name')).toHaveValue('Board');
  await view(page).getByRole('tab', { name: 'Table' }).click();
  await expect(view(page).getByLabel('View name')).toHaveValue('Table');
  await view(page).getByRole('tab', { name: 'Board' }).click();
  await view(page).getByRole('button', { name: 'View', exact: true }).click();

  // Moving without dragging works too.
  await lead.getByLabel('Move George to').selectOption({ label: 'Active' });
  await expect(active.getByRole('article', { name: 'George' })).toBeVisible();

  // The view's settings were saved on the page: another browser sees both tabs.
  const other = await openAs(browser, world, world.owner);
  await other.goto(`/w/${world.slug}/p/${clientsId}`);
  await expect(view(other).getByRole('tab', { name: 'Board' })).toBeVisible();
  void request;
});

test('a view on another page shows the chosen collection', async ({ browser }) => {
  const page = await openAs(browser, world, world.owner);
  await createPageInSpace(page, world, 'Team home');
  await insertView(page);
  await view(page).getByLabel('Find a collection').fill('Cli');
  await view(page).getByRole('button', { name: /Clients/ }).click();
  await expect(view(page).getByRole('table').getByRole('button', { name: 'George' })).toBeVisible();
});

test('a reader can change a view for themselves, but it isn’t saved', async ({ browser }) => {
  const page = await openAs(browser, world, viewer);
  await page.goto(`/w/${world.slug}/p/${clientsId}`);
  await view(page).getByRole('tab', { name: 'Table' }).click();
  await view(page).getByLabel('Layout').selectOption('calendar');
  await expect(view(page).getByText("Your changes to this view aren't saved.")).toBeVisible();
  await page.reload();
  await expect(view(page).getByRole('table')).toBeVisible();
  // Readers see values, not editors.
  await expect(view(page).getByRole('table').getByRole('group', { name: 'Status' })).toHaveCount(0);
});

test('a view of a collection the reader can’t open shows nothing of it', async ({ browser }) => {
  const owner = await openAs(browser, world, world.owner);
  const homeId = await createPageInSpace(owner, world, 'Deals overview');
  await insertView(owner);
  await view(owner).getByLabel('Find a collection').fill('Deals');
  await view(owner).getByRole('button', { name: /Deals/ }).click();
  await expect(view(owner).getByText('No pages yet.')).toBeVisible();

  const page = await openAs(browser, world, viewer);
  await page.goto(`/w/${world.slug}/p/${homeId}`);
  await expect(view(page).getByText("You can't open this collection, or it was removed.")).toBeVisible();
  await expect(view(page).getByRole('link', { name: 'Deals' })).toHaveCount(0);
});

test('calendar and timeline: an item on its day, dragged to another day; a bar on the timeline', async ({ browser, request }) => {
  const launch = await api<{ id: string }>(request, `/collections/${clientsId}/fields`, 'POST', { name: 'Launch', type: 'date' });
  const rows = await api<{ rows: Array<{ id: string; title: string }> }>(request, `/collections/${clientsId}/rows`, 'POST', {});
  const george = rows.rows.find((r) => r.title === 'George')!;
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const today = new Date();
  const day = iso(today);
  // A neighbouring day in the same month: on the same calendar page and inside the timeline's first window.
  const other = iso(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + (today.getUTCDate() > 1 ? -1 : 1))));
  await api(request, `/pages/${george.id}/fields`, 'PATCH', { [launch.id]: { start: day } });

  const page = await openAs(browser, world, world.owner);
  await page.goto(`/w/${world.slug}/p/${clientsId}`);
  await expectConnected(page);
  await view(page).getByLabel('Add a view').selectOption('calendar');
  const cell = (d: string) => view(page).getByRole('gridcell', { name: d });
  await expect(cell(day).getByRole('button', { name: 'George' })).toBeVisible();
  await cell(day).getByRole('button', { name: 'George' }).dragTo(cell(other));
  await expect(cell(other).getByRole('button', { name: 'George' })).toBeVisible();

  await view(page).getByLabel('Add a view').selectOption('timeline');
  const bar = view(page).getByRole('button', { name: new RegExp(`^George: ${other}`) });
  await expect(bar).toBeVisible();

  // Stretching the bar saves once.
  let saves = 0;
  page.on('request', (r) => {
    if (r.method() === 'PATCH' && r.url().endsWith(`/pages/${george.id}/fields`)) saves += 1;
  });
  const box = (await bar.boundingBox())!;
  await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width + 60, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
  await expect(view(page).getByRole('button', { name: new RegExp(`^George: ${other} to `) })).toBeVisible();
  expect(saves).toBe(1);
});
