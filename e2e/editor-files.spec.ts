import { expect, test, type Page } from '@playwright/test';
import { call, createPageInSpace, editorOf, openAs, seedWorld, treeLink, uploadViaApi } from './support.js';

/** A paste of real File objects from the desktop, as the browser sees it. */
async function pasteFiles(
  page: Page,
  files: { name: string; mimeType: string; text: string }[],
  target = '.bn-editor'
): Promise<void> {
  await page.evaluate(
    ({ items, target }) => {
      const data = new DataTransfer();
      for (const item of items) data.items.add(new File([item.text], item.name, { type: item.mimeType }));
      const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clipboardData', { value: data });
      (document.querySelector(target) as HTMLElement).dispatchEvent(event);
    },
    { items: files, target }
  );
}

/** Drops a file at a point in the editor, as the browser reports a real drag. */
async function dropFile(
  page: Page,
  at: { x: number; y: number },
  file: { name: string; mimeType: string; text: string }
): Promise<void> {
  await page.evaluate(
    ({ x, y, item }) => {
      const data = new DataTransfer();
      data.items.add(new File([item.text], item.name, { type: item.mimeType }));
      const event = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data, clientX: x, clientY: y });
      (document.querySelector('.bn-editor') as HTMLElement).dispatchEvent(event);
    },
    { ...at, item: file }
  );
}

test('a pasted text file becomes a file under the page, previewed in place and kept on reload', async ({ browser, request }) => {
  const world = await seedWorld(request, { reviewRequired: false });
  const page = await openAs(browser, world, world.owner);
  const pageId = await createPageInSpace(page, world, 'Paste target');

  await editorOf(page).click();
  await pasteFiles(page, [
    { name: 'Pasted notes.txt', mimeType: 'text/plain', text: `hello from paste ${world.suffix}` },
    { name: 'Second notes.txt', mimeType: 'text/plain', text: `second from paste ${world.suffix}` },
  ]);

  const embed = editorOf(page).getByRole('link', { name: /Pasted notes\.txt/ });
  await expect(embed).toBeVisible();
  await expect(editorOf(page).getByRole('link', { name: /Second notes\.txt/ })).toBeVisible();
  await expect(page.getByText(`hello from paste ${world.suffix}`)).toBeVisible();

  await embed.click();
  await page.waitForURL(/\/f\/[0-9a-f-]{36}$/);
  const fileId = page.url().split('/f/')[1]!;
  await expect(page.getByRole('heading', { name: 'Pasted notes.txt', level: 1 })).toBeVisible();

  // A proper Kinote file: it is filed under the page that pasted it.
  const file = await call<{ parentId: string | null }>(request, `/files/${fileId}`, {
    account: world.owner,
    tenantId: world.tenantId,
  });
  expect(file.parentId).toBe(pageId);

  // The embed lives in the page's Yjs document, preview included.
  await page.goto(`/w/${world.slug}/p/${pageId}`);
  await expect(page.getByText(`hello from paste ${world.suffix}`)).toBeVisible();
  await expect(page.getByText(`second from paste ${world.suffix}`)).toBeVisible();
  await expect(editorOf(page).getByRole('link', { name: /Pasted notes\.txt/ })).toBeVisible();
  await expect(editorOf(page).getByRole('link', { name: /Second notes\.txt/ })).toBeVisible();
});

test('a file pasted with focus on a tree row goes under that row’s folder', async ({ browser, request }) => {
  const world = await seedWorld(request, { reviewRequired: false });
  const bytes = `tree paste ${world.suffix}`;
  // The same bytes already sit at the space root; an explicit tree-row paste must still make a copy under the page.
  await uploadViaApi(request, world, world.owner, {
    name: 'Tree notes.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from(bytes),
  });
  const page = await openAs(browser, world, world.owner);
  const pageId = await createPageInSpace(page, world, 'Paste in tree');

  const treeNodes = async () =>
    (
      await call<{ nodes: { id: string; title: string; parentId: string | null }[] }>(
        request,
        `/spaces/${world.spaceId}/tree`,
        { account: world.owner, tenantId: world.tenantId }
      )
    ).nodes;

  // Focus on the page row: the pasted file goes under that page. The event is dispatched on
  // the body, as Firefox reports it, while the row is what has focus.
  const pageRow = treeLink(page, 'Paste in tree');
  await pageRow.click();
  await pageRow.focus();
  await pasteFiles(page, [{ name: 'Tree notes.txt', mimeType: 'text/plain', text: bytes }], 'body');
  // The tree cache lives for five seconds; poll until the copy lands instead of racing the upload.
  await expect
    .poll(async () => (await treeNodes()).filter((n) => n.title === 'Tree notes.txt').map((n) => n.parentId))
    .toEqual(expect.arrayContaining([null, pageId]));

  // Focus on the file row: the file has no children, so the paste goes to its folder.
  const fileRow = pageRow
    .locator('xpath=ancestor::li[1]')
    .getByRole('link', { name: /^Tree notes\.txt(?:\s|$)/ })
    .first();
  await fileRow.click();
  await fileRow.focus();
  await pasteFiles(page, [{ name: 'Sibling notes.txt', mimeType: 'text/plain', text: `sibling paste ${world.suffix}` }], ':focus');
  await expect
    .poll(async () => (await treeNodes()).find((n) => n.title === 'Sibling notes.txt')?.parentId)
    .toBe(pageId);
});

test('a dropped file lands at the drop point and is previewed in place', async ({ browser, request }) => {
  const world = await seedWorld(request, { reviewRequired: false });
  const page = await openAs(browser, world, world.owner);
  await createPageInSpace(page, world, 'Drop target');

  await editorOf(page).click();
  await page.keyboard.type('Drop here');
  const box = await page.getByText('Drop here').boundingBox();
  expect(box).not.toBeNull();
  await dropFile(
    page,
    { x: box!.x + box!.width / 2, y: box!.y + box!.height * 0.75 },
    { name: 'Dropped notes.txt', mimeType: 'text/plain', text: `dropped preview ${world.suffix}` }
  );

  await expect(editorOf(page).getByRole('link', { name: /Dropped notes\.txt/ })).toBeVisible();
  await expect(page.getByText(`dropped preview ${world.suffix}`)).toBeVisible();
  await expect(page.getByText('Drop here')).toBeVisible();
});
