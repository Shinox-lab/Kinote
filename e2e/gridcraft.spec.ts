import { expect, test, type Page } from '@playwright/test';
import { xlsx } from './fixtures.js';
import {
  addMember,
  call,
  openAs,
  replaceViaApi,
  seedWorld,
  uploadViaApi,
  waitForFileBadge,
  type Account,
  type TestFile,
  type World,
} from './support.js';

const BOOK = (label: string) =>
  xlsx('Budget.xlsx', label, [
    { name: 'Income', rows: [['Item', 'Amount'], ['Sales', 1200]] },
  ]);

/** A same-origin fake of the GridCraft bridge: no WASM, just the messages the editor sends. */
function fakeGridCraft(bytes: Buffer): string {
  return `<!doctype html>
<html><body>
<p id="opened">Waiting</p>
<button id="dirty">dirty</button>
<button id="clean">clean</button>
<button id="save">save</button>
<button id="save-pdf">save pdf</button>
<script>
  const source = Uint8Array.from(atob('${bytes.toString('base64')}'), (c) => c.charCodeAt(0)).buffer;
  const opened = document.getElementById('opened');
  // The parent installs its listener after the iframe mounts; retry until it answers.
  const ready = setInterval(() => parent.postMessage({ type: 'gridcraft:ready' }, '*'), 100);
  addEventListener('message', (event) => {
    const data = event.data;
    if (data && data.type === 'gridcraft:open') {
      clearInterval(ready);
      opened.textContent = 'Opened ' + data.name + ' (' + data.bytes.byteLength + ' bytes)';
    }
  });
  function send(name) {
    const copy = source.slice(0);
    parent.postMessage({ type: 'gridcraft:save', name, bytes: copy }, '*', [copy]);
  }
  document.getElementById('dirty').onclick = () => parent.postMessage({ type: 'gridcraft:dirty', dirty: true }, '*');
  document.getElementById('clean').onclick = () => parent.postMessage({ type: 'gridcraft:dirty', dirty: false }, '*');
  document.getElementById('save').onclick = () => send('Budget.xlsx');
  document.getElementById('save-pdf').onclick = () => send('Budget.pdf');
  parent.postMessage({ type: 'gridcraft:ready' }, '*');
</script>
</body></html>`;
}

async function serveFake(page: Page, bytes: Buffer): Promise<void> {
  await page.route(/\/gridcraft\//, (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: fakeGridCraft(bytes) })
  );
}

function versionsOf(request: Parameters<typeof call>[0], world: World, account: Account, id: string) {
  return call<{ id: string; number: number }[]>(request, `/files/${id}/versions`, {
    account,
    tenantId: world.tenantId,
  });
}

async function openFakeEditor(page: Page, world: World, id: string, file: TestFile) {
  await serveFake(page, file.buffer);
  await page.goto(`/w/${world.slug}/f/${id}`);
  await page.getByRole('button', { name: 'Edit in GridCraft' }).click();
  const frame = page.frameLocator('iframe[title="Budget.xlsx spreadsheet editor"]');
  await expect(frame.locator('#opened')).toHaveText(`Opened Budget.xlsx (${file.buffer.length} bytes)`);
  return frame;
}

test('editor opens and saves a new version', async ({ browser, request }) => {
  const world = await seedWorld(request, { reviewRequired: false });
  const original = BOOK(world.suffix);
  const id = await uploadViaApi(request, world, world.owner, original);
  await waitForFileBadge(request, world, world.owner, id, /^Indexed/);

  const page = await openAs(browser, world, world.owner);
  const edited = xlsx('Budget.xlsx', `${world.suffix}-edited`, [
    { name: 'Income', rows: [['Item', 'Amount'], ['Sales', 1300]] },
  ]);
  await serveFake(page, edited.buffer);
  await page.goto(`/w/${world.slug}/f/${id}`);

  const preview = page.getByRole('region', { name: 'Preview' });
  await expect(preview.getByText('Read-only preview')).toBeVisible();
  await expect(preview.getByRole('cell', { name: 'Sales' })).toBeVisible();
  const edit = page.getByRole('button', { name: 'Edit in GridCraft' });
  await expect(edit).toBeVisible();
  await edit.click();

  const iframe = page.locator('iframe[title="Budget.xlsx spreadsheet editor"]');
  await expect(iframe).toHaveAttribute('sandbox', 'allow-scripts');
  const src = await iframe.getAttribute('src');
  expect(src).toContain('host=parent');
  expect(src).toContain('webgl');
  expect(src).toContain('chrome=none');
  expect(src).toContain(`author=${encodeURIComponent(world.owner.user.name)}`);
  expect(src).not.toContain('page=');
  const frame = page.frameLocator('iframe[title="Budget.xlsx spreadsheet editor"]');
  await expect(frame.locator('#opened')).toHaveText(`Opened Budget.xlsx (${original.buffer.length} bytes)`);

  // Another opaque-origin frame has origin 'null' too, but it is not the editor window.
  await page.evaluate((base64) => {
    const impostor = document.createElement('iframe');
    impostor.setAttribute('sandbox', 'allow-scripts');
    impostor.hidden = true;
    impostor.srcdoc =
      '<script>const b = Uint8Array.from(atob("' + base64 + '"), (c) => c.charCodeAt(0)).buffer;' +
      'parent.postMessage({ type: "gridcraft:save", name: "Budget.xlsx", bytes: b }, "*");</scr' + 'ipt>';
    document.body.append(impostor);
  }, edited.buffer.toString('base64'));
  await expect
    .poll(async () => (await versionsOf(request, world, world.owner, id)).length, { timeout: 1500 })
    .toBe(1);
  await page.waitForTimeout(500);
  expect(await versionsOf(request, world, world.owner, id)).toHaveLength(1);

  await frame.locator('#save').click();
  await expect(page.getByRole('status').filter({ hasText: 'Saved as version 2. The new version is being read.' })).toBeVisible();
  const versions = await versionsOf(request, world, world.owner, id);
  expect(versions.map((version) => version.number)).toEqual([2, 1]);
  await waitForFileBadge(request, world, world.owner, id, /^Indexed · v2$/);
  await expect(page.getByRole('status', { name: /File status: Indexed · v2/ })).toBeVisible();

  // The editor stays open on the same workbook after a save (here in full screen), and saves again.
  await expect(page.getByRole('status').filter({ hasText: /^Saved as version 2\.$/ })).toBeVisible();
  await expect(frame.locator('#opened')).toHaveText(`Opened Budget.xlsx (${original.buffer.length} bytes)`);
  await page.getByRole('button', { name: 'Full screen' }).click();
  await frame.locator('#dirty').click();
  await frame.locator('#save').click();
  await expect(page.getByRole('status').filter({ hasText: 'No changes to save.' })).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Budget.xlsx spreadsheet editor' })).toBeVisible();
  await page.getByRole('button', { name: 'Exit full screen' }).click();

  // Back to the preview shows the latest version.
  await page.getByRole('button', { name: 'Back to preview' }).click();
  await expect(preview.getByText('Read-only preview')).toBeVisible();
  await expect(preview.getByRole('cell', { name: '1300' })).toBeVisible();
});

test('viewers and older versions stay read-only', async ({ browser, request }) => {
  const world = await seedWorld(request, { reviewRequired: false });
  const viewer = await addMember(request, world, 'Vera Viewer', 'viewer');
  const id = await uploadViaApi(request, world, world.owner, BOOK(world.suffix));
  await waitForFileBadge(request, world, world.owner, id, /^Indexed/);

  const viewerPage = await openAs(browser, world, viewer);
  await viewerPage.goto(`/w/${world.slug}/f/${id}`);
  const preview = viewerPage.getByRole('region', { name: 'Preview' });
  await expect(preview.getByRole('cell', { name: 'Sales' })).toBeVisible();
  await expect(viewerPage.getByRole('button', { name: 'Edit in GridCraft' })).toHaveCount(0);

  const v1 = (await versionsOf(request, world, world.owner, id))[0]!;
  const next = await replaceViaApi(
    request,
    world,
    world.owner,
    id,
    xlsx('Budget.xlsx', `${world.suffix}-v2`, [{ name: 'Income', rows: [['Item', 'Amount'], ['Sales', 1400]] }])
  );
  expect(next.version.number).toBe(2);
  await waitForFileBadge(request, world, world.owner, id, /^Indexed · v2$/);

  const ownerPage = await openAs(browser, world, world.owner);
  await ownerPage.goto(`/w/${world.slug}/f/${id}?v=${v1.id}`);
  await expect(ownerPage.getByText('Viewing an older version. Open the latest version to edit it.')).toBeVisible();
  await expect(ownerPage.getByRole('button', { name: 'Edit in GridCraft' })).toHaveCount(0);
});

test('unsaved changes prompt before leaving', async ({ browser, request }) => {
  const world = await seedWorld(request, { reviewRequired: false });
  const file = BOOK(world.suffix);
  const id = await uploadViaApi(request, world, world.owner, file);
  await waitForFileBadge(request, world, world.owner, id, /^Indexed/);

  const page = await openAs(browser, world, world.owner);
  const frame = await openFakeEditor(page, world, id, file);
  await frame.locator('#dirty').click();
  await expect(page.getByRole('status').filter({ hasText: 'Unsaved changes' })).toBeVisible();

  const spaceLink = page.locator('nav[aria-label="Breadcrumb"]').getByRole('link', { name: 'Docs' });
  const dialogMessage = new Promise<string>((resolve) => {
    page.once('dialog', (dialog) => {
      resolve(dialog.message());
      void dialog.dismiss();
    });
  });
  await spaceLink.click();
  expect(await dialogMessage).toBe('Discard unsaved spreadsheet changes?');
  await expect(page).toHaveURL(new RegExp(`/f/${id}$`));

  await frame.locator('#clean').click();
  await expect(page.getByRole('status').filter({ hasText: 'Editing Budget.xlsx. Press Ctrl+S to save a new version.' })).toBeVisible();
  await spaceLink.click();
  await page.waitForURL(new RegExp(`/w/${world.slug}/s/${world.spaceSlug}$`));
});

test('a non-XLSX save downloads instead of uploading', async ({ browser, request }) => {
  const world = await seedWorld(request, { reviewRequired: false });
  const file = BOOK(world.suffix);
  const id = await uploadViaApi(request, world, world.owner, file);
  await waitForFileBadge(request, world, world.owner, id, /^Indexed/);

  const page = await openAs(browser, world, world.owner);
  const frame = await openFakeEditor(page, world, id, file);
  const downloadPromise = page.waitForEvent('download');
  await frame.locator('#save-pdf').click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('Budget.pdf');
  await expect(page.getByRole('status').filter({ hasText: 'GridCraft is bound to Budget.xlsx. Downloaded a copy instead.' })).toBeVisible();
  await page.waitForTimeout(300);
  expect(await versionsOf(request, world, world.owner, id)).toHaveLength(1);
});

test('an editor that never starts falls back to a message', async ({ browser, request }) => {
  const world = await seedWorld(request, { reviewRequired: false });
  const id = await uploadViaApi(request, world, world.owner, BOOK(world.suffix));
  await waitForFileBadge(request, world, world.owner, id, /^Indexed/);

  const page = await openAs(browser, world, world.owner);
  await page.route(/\/gridcraft\//, (route) => route.fulfill({ status: 502, body: 'Bad gateway' }));
  await page.clock.install();
  await page.goto(`/w/${world.slug}/f/${id}`);
  await page.getByRole('button', { name: 'Edit in GridCraft' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Loading editor…' })).toBeVisible();
  // The start timer is armed by an effect; keep advancing the fake clock until it has fired.
  await expect
    .poll(async () => {
      await page.clock.fastForward(31_000);
      return page.getByText("GridCraft couldn't start: it did not respond.").count();
    })
    .toBeGreaterThan(0);
  await expect(
    page.getByRole('status').filter({ hasText: "GridCraft couldn't start: it did not respond. Use the read-only preview." })
  ).toBeVisible();
  await page.getByRole('button', { name: 'Back to preview' }).click();
  await expect(page.getByRole('region', { name: 'Preview' }).getByRole('cell', { name: 'Sales' })).toBeVisible();
});

test('a rejected save keeps the edits, offers a copy and blocks navigation', async ({ browser, request }) => {
  const world = await seedWorld(request, { reviewRequired: false });
  const file = BOOK(world.suffix);
  const id = await uploadViaApi(request, world, world.owner, file);
  await waitForFileBadge(request, world, world.owner, id, /^Indexed/);

  const page = await openAs(browser, world, world.owner);
  await page.route(/\/api\/v1\/files\/[^/]+\/versions$/, (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'internal', message: 'Disk full' } }) })
      : route.fallback()
  );
  const frame = await openFakeEditor(page, world, id, file);
  await frame.locator('#dirty').click();
  await frame.locator('#save').click();

  await expect(page.getByRole('status').filter({ hasText: /^Couldn't save: .*Your edits are still here; download a copy\.$/ })).toBeVisible();
  expect(await versionsOf(request, world, world.owner, id)).toHaveLength(1);

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download a copy' }).click();
  expect((await downloadPromise).suggestedFilename()).toBe('Budget.xlsx');

  // Even though GridCraft reported itself clean, the page still holds unsaved bytes.
  await frame.locator('#clean').click();
  const dialogMessage = new Promise<string>((resolve) => {
    page.once('dialog', (dialog) => {
      resolve(dialog.message());
      void dialog.dismiss();
    });
  });
  await page.locator('nav[aria-label="Breadcrumb"]').getByRole('link', { name: 'Docs' }).click();
  expect(await dialogMessage).toBe('Discard unsaved spreadsheet changes?');
  await expect(page).toHaveURL(new RegExp(`/f/${id}$`));
});

test('full screen covers the page without reloading the editor', async ({ browser, request }) => {
  const world = await seedWorld(request, { reviewRequired: false });
  const file = BOOK(world.suffix);
  const id = await uploadViaApi(request, world, world.owner, file);
  await waitForFileBadge(request, world, world.owner, id, /^Indexed/);

  const page = await openAs(browser, world, world.owner);
  const frame = await openFakeEditor(page, world, id, file);
  await frame.locator('#dirty').click();
  const editor = page.frame({ url: /\/gridcraft\// })!;
  await editor.evaluate(() => ((window as unknown as { marker: number }).marker = 1));

  await page.getByRole('button', { name: 'Full screen' }).click();
  const dialog = page.getByRole('dialog', { name: 'Budget.xlsx spreadsheet editor' });
  await expect(dialog).toBeVisible();
  const viewport = page.viewportSize()!;
  const box = (await dialog.boundingBox())!;
  expect(box).toMatchObject({ x: 0, y: 0, width: viewport.width, height: viewport.height });
  const iframeBox = (await page.locator('iframe[title="Budget.xlsx spreadsheet editor"]').boundingBox())!;
  expect(iframeBox.y + iframeBox.height).toBeCloseTo(viewport.height, 0);
  await expect(page.getByRole('status').filter({ hasText: 'Unsaved changes' })).toBeVisible();
  expect(await editor.evaluate(() => (window as unknown as { marker?: number }).marker)).toBe(1);

  await page.getByRole('button', { name: 'Exit full screen' }).focus();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Full screen' })).toBeVisible();
  expect(await editor.evaluate(() => (window as unknown as { marker?: number }).marker)).toBe(1);
});
