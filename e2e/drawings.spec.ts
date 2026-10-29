import { expect, test, type Page } from '@playwright/test';
import {
  addMember,
  approveAll,
  call,
  createPageInSpace,
  editorOf,
  openAs,
  runPageAction,
  searchPassages,
  seedWorld,
  type Account,
  type World,
} from './support.js';

interface Element {
  id: string;
  type: string;
  text?: string;
  isDeleted?: boolean;
}

/** Inserts a drawing from the slash menu on an empty line at the end; returns its drawing id once the canvas is up. */
async function insertDrawing(page: Page): Promise<string> {
  await editorOf(page).click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('/drawing');
  await page.getByRole('option', { name: /^Drawing/ }).click();
  const block = page.locator('[data-drawing-id]').last();
  await expect(block.locator('canvas.interactive')).toBeVisible();
  return (await block.getAttribute('data-drawing-id'))!;
}

/** The canvas of a drawing block, for pointer work. */
function canvasOf(page: Page, drawingId: string) {
  return page.locator(`[data-drawing-id="${drawingId}"] canvas.interactive`);
}

/** Draws a rectangle with the rectangle tool, from (x, y) to (x + 80, y + 60) inside the canvas. */
async function drawRectangle(page: Page, drawingId: string, x: number, y: number) {
  const canvas = canvasOf(page, drawingId);
  const box = (await canvas.boundingBox())!;
  await canvas.click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('r');
  await page.mouse.move(box.x + x, box.y + y);
  await page.mouse.down();
  await page.mouse.move(box.x + x + 80, box.y + y + 60, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.press('Escape');
}

/** Writes a text element at (x, y) inside the canvas. */
async function writeText(page: Page, drawingId: string, x: number, y: number, text: string) {
  const canvas = canvasOf(page, drawingId);
  await canvas.click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('t');
  await canvas.click({ position: { x, y } });
  await page.keyboard.type(text);
  await page.keyboard.press('Escape');
}

/** The live (stored) elements of a drawing, through the api. */
async function liveShapes(page: Page, world: World, account: Account, pageId: string, drawingId: string): Promise<Element[]> {
  const res = await call<{ elements: Element[] }>(page.request, `/pages/${pageId}/drawings/${drawingId}`, { account, tenantId: world.tenantId });
  return res.elements;
}
const rectangles = (list: Element[]) => list.filter((e) => e.type === 'rectangle').length;

test('two people draw in one drawing and both keep their shapes', async ({ browser, request }) => {
  const world = await seedWorld(request, { reviewRequired: false });
  const bea = await addMember(request, world, 'Bea Editor', 'editor');
  const a = await openAs(browser, world, world.owner);
  const pageId = await createPageInSpace(a, world, 'Flows');
  const drawingId = await insertDrawing(a);

  const b = await openAs(browser, world, bea);
  await b.goto(`/w/${world.slug}/p/${pageId}`);
  await expect(canvasOf(b, drawingId)).toBeVisible();

  await drawRectangle(a, drawingId, 60, 60);
  await drawRectangle(b, drawingId, 260, 120);

  // Both shapes reach the stored page, and each side shows both.
  await expect.poll(async () => rectangles(await liveShapes(a, world, world.owner, pageId, drawingId)), { timeout: 30_000 }).toBe(2);
  for (const p of [a, b]) {
    await p.reload();
    await expect(canvasOf(p, drawingId)).toBeVisible();
  }
  await expect.poll(async () => rectangles(await liveShapes(b, world, bea, pageId, drawingId))).toBe(2);
});

test('a drawing in a review space waits, then its words are searchable', async ({ browser, request }) => {
  const world = await seedWorld(request, { reviewRequired: true });
  const rae = await addMember(request, world, 'Rae Reviewer', 'reviewer');
  const a = await openAs(browser, world, world.owner);
  const pageId = await createPageInSpace(a, world, 'Payments');
  const drawingId = await insertDrawing(a);
  await writeText(a, drawingId, 120, 120, 'Payment flow');
  await expect.poll(async () => (await liveShapes(a, world, world.owner, pageId, drawingId)).some((e) => e.text === 'Payment flow'), {
    timeout: 30_000,
  }).toBe(true);

  await runPageAction(a, 'Submit for review');
  expect(await searchPassages(request, world, world.owner, 'Payment flow')).toEqual([]);
  await expect.poll(() => approveAll(request, world, rae), { timeout: 30_000 }).toBeGreaterThan(0);
  await expect
    .poll(async () => (await searchPassages(request, world, rae, 'Payment flow')).some((p) => p.includes('Payment flow')), { timeout: 60_000 })
    .toBe(true);
});

test('a page without drawings does not load Excalidraw; one with a drawing gets fonts from Kinote', async ({ browser, request }) => {
  const world = await seedWorld(request, { reviewRequired: false });
  const a = await openAs(browser, world, world.owner);
  const fonts: string[] = [];
  a.on('request', (req) => {
    if (/\.woff2?(\?|$)/.test(req.url())) fonts.push(req.url());
  });
  // The lazy canvas module sets the asset path when it loads; it is the only way Excalidraw arrives.
  const excalidrawLoaded = () => a.evaluate(() => 'EXCALIDRAW_ASSET_PATH' in window);
  await createPageInSpace(a, world, 'Plain page');
  await editorOf(a).click();
  await a.keyboard.type('Nothing to draw here.');
  await a.reload();
  await expect(editorOf(a)).toContainText('Nothing to draw here.');
  expect(await excalidrawLoaded()).toBe(false);

  const drawingId = await insertDrawing(a);
  expect(await excalidrawLoaded()).toBe(true);
  await writeText(a, drawingId, 100, 100, 'Fonts');
  await expect.poll(() => fonts.length, { timeout: 30_000 }).toBeGreaterThan(0);
  // Every font comes from Kinote's own origin (the console's fonts under /assets, Excalidraw's under /excalidraw-assets).
  const origin = new URL(a.url()).origin;
  expect(fonts.filter((f) => new URL(f).origin !== origin)).toEqual([]);
  expect(fonts.some((f) => new URL(f).pathname.startsWith('/excalidraw-assets/fonts/'))).toBe(true);
});

test('restore brings an earlier drawing back', async ({ browser, request }) => {
  const world = await seedWorld(request, { reviewRequired: false });
  const a = await openAs(browser, world, world.owner);
  const pageId = await createPageInSpace(a, world, 'Restore me');
  const drawingId = await insertDrawing(a);
  await drawRectangle(a, drawingId, 60, 60);
  await expect.poll(async () => rectangles(await liveShapes(a, world, world.owner, pageId, drawingId)), { timeout: 30_000 }).toBe(1);
  await runPageAction(a, 'Index now');
  await a.keyboard.press('Escape');
  await expect.poll(async () => (await call<unknown[]>(request, `/pages/${pageId}/versions`, { account: world.owner, tenantId: world.tenantId })).length).toBe(1);

  await drawRectangle(a, drawingId, 260, 120);
  await expect.poll(async () => rectangles(await liveShapes(a, world, world.owner, pageId, drawingId)), { timeout: 30_000 }).toBe(2);
  await runPageAction(a, 'Index now');
  await a.keyboard.press('Escape');
  await expect.poll(async () => (await call<unknown[]>(request, `/pages/${pageId}/versions`, { account: world.owner, tenantId: world.tenantId })).length).toBe(2);

  await call(request, `/pages/${pageId}/versions/1/restore`, { account: world.owner, tenantId: world.tenantId, method: 'POST' });
  await expect.poll(async () => rectangles(await liveShapes(a, world, world.owner, pageId, drawingId)), { timeout: 30_000 }).toBe(1);
  // The open editor drops the removed shape too.
  await a.reload();
  await expect(canvasOf(a, drawingId)).toBeVisible();
});
