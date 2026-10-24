import { expect, test } from '@playwright/test';
import { corruptDocx, docx, pptx, realPdf, xlsx } from './fixtures.js';
import {
  addMember,
  approveAll,
  expandSpace,
  fakePdf,
  fakePng,
  openAs,
  searchPassages,
  seedWorld,
  textFile,
  treeLink,
  uploadPanel,
  uploadThroughMenu,
  uploadViaApi,
  waitForFileBadge,
} from './support.js';

const sidebar = (page: import('@playwright/test').Page) => page.getByRole('complementary', { name: 'Sidebar' });

test('a file uploaded from the add menu is read, indexed and listed in the sidebar', async ({ browser, request }) => {
  const world = await seedWorld(request, { reviewRequired: false });
  const page = await openAs(browser, world, world.owner);
  await page.goto(`/w/${world.slug}`);
  await sidebar(page).getByRole('button', { name: 'Expand Docs' }).click();

  const file = fakePdf('Leave report.pdf', world.suffix, 'Employees get twenty days of leave.', 'Parental leave is sixteen weeks.');
  await uploadThroughMenu(page, 'Docs', [file]);

  const panel = uploadPanel(page);
  await expect(panel).toContainText('Leave report.pdf');
  await expect(panel).toContainText('Indexed · v1');
  const row = treeLink(page, 'Leave report.pdf');
  await expect(row).toBeVisible();
  await row.click();
  await page.waitForURL(/\/f\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { name: 'Leave report.pdf', level: 1 })).toBeVisible();
  await expect(page.getByRole('status', { name: 'File status: Indexed · v1' })).toBeVisible();
});

test('the file identity, rail, rename and the Info sheet below 1200', async ({ browser, request }) => {
  const world = await seedWorld(request, { reviewRequired: false });
  const id = await uploadViaApi(
    request,
    world,
    world.owner,
    textFile('Policy.txt', 'text/plain', `A policy file ${world.suffix}.\nSecond line.`)
  );
  await waitForFileBadge(request, world, world.owner, id, /^Indexed/);

  const page = await openAs(browser, world, world.owner);
  await page.goto(`/w/${world.slug}/f/${id}`);
  await expect(page.getByRole('heading', { name: 'Policy.txt', level: 1 })).toBeVisible();
  await expect(page.getByText(/TXT ·/)).toBeVisible();
  await expect(treeLink(page, 'Policy.txt')).toContainText('TXT');

  await expect(page.getByRole('tab', { name: /^Details/ })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tabpanel', { name: 'Details' })).toContainText('TXT');
  await page.getByRole('tab', { name: /^Versions/ }).click();
  await expect(page.getByRole('list', { name: 'Versions' })).toContainText('Version 1');

  await page.getByRole('button', { name: 'File actions' }).click();
  await expect(page.getByRole('button', { name: /^Replace file/ })).toBeVisible();
  await page.getByRole('button', { name: /^Rename/ }).click();
  await page.getByLabel('New title').fill('Policies 2026.txt');
  await page.getByLabel('New title').press('Enter');
  await expect(page.getByRole('heading', { name: 'Policies 2026.txt', level: 1 })).toBeVisible();
  await expect(treeLink(page, 'Policies 2026.txt')).toBeVisible();

  await page.setViewportSize({ width: 1100, height: 900 });
  await page.getByRole('button', { name: 'Info' }).click();
  const sheet = page.getByRole('dialog', { name: 'File information' });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole('tab', { name: /^Chunks/ })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
});

test('a replacement waits for review while the old version keeps answering search', async ({ browser, request }) => {
  const world = await seedWorld(request, { reviewRequired: true });
  const reviewer = await addMember(request, world, 'Rita Reviewer', 'reviewer');
  const word = `zebra${world.suffix}`;
  const id = await uploadViaApi(request, world, world.owner, fakePdf('Policy.pdf', `${world.suffix}-1`, `The ${word} rule applies to all staff.`));

  const page = await openAs(browser, world, world.owner);
  await waitForFileBadge(request, world, world.owner, id, 'Not indexed (awaiting approval)');
  await page.goto(`/w/${world.slug}/f/${id}`);
  await expect(page.getByRole('status', { name: 'File status: Not indexed (awaiting approval)' })).toBeVisible();
  // Nothing is searchable until it is approved.
  expect(await searchPassages(request, world, world.owner, word)).toEqual([]);

  await approveAll(request, world, reviewer);
  await expect.poll(() => searchPassages(request, world, world.owner, word)).toHaveLength(1);
  await page.reload();
  await expect(page.getByRole('status', { name: 'File status: Indexed · v1' })).toBeVisible();

  // Replace: version 2 waits, version 1 still answers.
  const next = `giraffe${world.suffix}`;
  const replacement = fakePdf('Policy.pdf', `${world.suffix}-2`, `The ${next} rule replaces it.`);
  await page.getByLabel('Choose the replacement file').setInputFiles(replacement);
  await expect(page.getByRole('status', { name: 'File status: Indexed · v1, v2 awaiting approval' })).toBeVisible();
  await page.getByRole('tab', { name: /^Versions/ }).click();
  await expect(page.getByRole('list', { name: 'Versions' }).getByRole('listitem')).toHaveCount(2);
  // Search always ranks something (it is hybrid), so look at what it returns rather than at whether it returns.
  const waiting = await searchPassages(request, world, world.owner, next);
  expect(waiting.length).toBeGreaterThan(0);
  expect(waiting.every((p) => p.startsWith('1: ') && p.includes(word))).toBe(true);

  await approveAll(request, world, reviewer);
  await expect
    .poll(async () => (await searchPassages(request, world, world.owner, next)).every((p) => p.startsWith('2: ') && p.includes(next)))
    .toBe(true);
  await page.reload();
  await expect(page.getByRole('status', { name: 'File status: Indexed · v2' })).toBeVisible();
});

test('a reviewer reads the text of a waiting file, approves it, and the chunk inspector shows how it was cut', async ({ browser, request }) => {
  const world = await seedWorld(request, { reviewRequired: true });
  const reviewer = await addMember(request, world, 'Rita Reviewer', 'reviewer');
  const sentence = `Parental leave lasts sixteen weeks ${world.suffix}.`;
  const id = await uploadViaApi(
    request,
    world,
    world.owner,
    fakePdf('Handbook.pdf', world.suffix, 'Welcome to the company.', sentence)
  );
  await waitForFileBadge(request, world, world.owner, id, 'Not indexed (awaiting approval)');

  const page = await openAs(browser, world, reviewer);
  await page.goto(`/w/${world.slug}/reviews`);
  const item = page.getByRole('list', { name: 'Changes waiting for review' }).getByRole('listitem').filter({ hasText: 'Handbook.pdf' });
  await item.getByRole('button').click();
  const detail = page.getByRole('region', { name: 'Review detail' });
  await expect(detail).toContainText('PDF ·');
  await expect(detail.getByRole('button', { name: 'Show changes' })).toHaveCount(0);
  await expect(detail.getByText(sentence)).toBeVisible();
  await expect(detail).toContainText('2 pages');
  await detail.getByRole('button', { name: 'Approve' }).click();
  await expect(item).toHaveCount(0);

  await page.goto(`/w/${world.slug}/f/${id}`);
  await expect(page.getByRole('status', { name: /File status: Indexed/ })).toBeVisible({ timeout: 30_000 });
  await page.getByRole('tab', { name: /^Chunks/ }).click();
  const chunks = page.getByRole('list', { name: 'Chunks' });
  await expect(chunks).toContainText(sentence);
  await expect(chunks).toContainText('Page 2');
  await expect(page.getByText(/chunks · 2 pages/)).toBeVisible();
  await expect(page.getByText(/2 pages/).first()).toBeVisible();
});

test('text and image files open in place', async ({ browser, request }) => {
  const world = await seedWorld(request, { reviewRequired: false });
  const text = await uploadViaApi(request, world, world.owner, textFile('Notes.txt', 'text/plain', `First line ${world.suffix}\nSecond line <b>not bold</b>`));
  const image = await uploadViaApi(request, world, world.owner, fakePng('Diagram.png', world.suffix, 'A diagram of the process.'));
  await waitForFileBadge(request, world, world.owner, text, /^Indexed/);
  await waitForFileBadge(request, world, world.owner, image, /^Indexed/);

  const page = await openAs(browser, world, world.owner);
  await page.goto(`/w/${world.slug}/f/${text}`);
  const preview = page.getByRole('region', { name: 'Preview' });
  await expect(preview).toContainText(`First line ${world.suffix}`);
  // Markup in a text file is shown as text, never rendered.
  await expect(preview).toContainText('<b>not bold</b>');
  await expect(preview.locator('b')).toHaveCount(0);

  await page.goto(`/w/${world.slug}/f/${image}`);
  const img = page.getByRole('img', { name: 'Diagram.png' });
  await expect(img).toBeVisible();
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);

  // Download goes through the session, not a link with a token in it.
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download', exact: true }).click()]);
  expect(download.suggestedFilename()).toBe('Diagram.png');
});

test('a viewer sees only what is published: nothing while the file waits for review, then the file', async ({ browser, request }) => {
  const world = await seedWorld(request, { reviewRequired: true });
  const reviewer = await addMember(request, world, 'Rita Reviewer', 'reviewer');
  const viewer = await addMember(request, world, 'Vera Viewer', 'viewer');
  const sentence = `Held back until approved ${world.suffix}.`;
  const id = await uploadViaApi(request, world, world.owner, fakePdf('Draft.pdf', world.suffix, sentence));
  await waitForFileBadge(request, world, world.owner, id, 'Not indexed (awaiting approval)');

  const page = await openAs(browser, world, viewer);
  const bytesRequests: string[] = [];
  page.on('request', (r) => {
    if (/\/versions\/[^/]+\/(file|text|chunks)/.test(r.url())) bytesRequests.push(r.url());
  });
  await page.goto(`/w/${world.slug}/f/${id}`);
  await expect(page.getByRole('heading', { name: 'Draft.pdf', level: 1 })).toBeVisible();
  await expect(page.getByRole('note')).toHaveText('Nothing has been published yet.');
  await expect(page.getByRole('region', { name: 'Preview' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Search chunks' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'File actions' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Replace file' })).toHaveCount(0);
  expect(bytesRequests).toEqual([]);

  await approveAll(request, world, reviewer);
  await waitForFileBadge(request, world, world.owner, id, /^Indexed/);
  await page.reload();
  await expect(page.getByRole('region', { name: 'Preview' })).toBeVisible();
  await expect(page.getByRole('note')).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Search chunks' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Download', exact: true })).toBeVisible();
});

test('a hostile Markdown file is shown as text and runs nothing', async ({ browser, request }) => {
  const world = await seedWorld(request, { reviewRequired: false });
  const md = [
    '# A heading',
    '',
    '<script>window.__pwned = 1</script>',
    '',
    '[bad link](javascript:window.__pwned=1) and <img src=x onerror="window.__pwned=1"> and [good](https://example.com/ok)',
    '',
    `Safe paragraph ${world.suffix}.`,
  ].join('\n');
  const id = await uploadViaApi(request, world, world.owner, textFile('Evil.md', 'text/markdown', md));
  await waitForFileBadge(request, world, world.owner, id, /^Indexed/);

  const page = await openAs(browser, world, world.owner);
  const dialogs: string[] = [];
  page.on('dialog', (d) => {
    dialogs.push(d.message());
    void d.dismiss();
  });
  await page.goto(`/w/${world.slug}/f/${id}`);
  const preview = page.getByRole('region', { name: 'Preview' });
  await expect(preview.getByRole('heading', { name: 'A heading' })).toBeVisible();
  await expect(preview).toContainText(`Safe paragraph ${world.suffix}.`);
  // The script is on screen as words, and nothing ran.
  await expect(preview).toContainText('<script>window.__pwned = 1</script>');
  await expect(preview.locator('script, img, iframe')).toHaveCount(0);
  await expect(preview.locator('a[href^="javascript"]')).toHaveCount(0);
  await expect(preview.getByRole('link', { name: 'good' })).toHaveAttribute('href', 'https://example.com/ok');
  await expect(preview.getByRole('link', { name: 'good' })).toHaveAttribute('rel', 'noopener noreferrer nofollow');
  expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
  expect(dialogs).toEqual([]);
});

test('a Word document opens as text; a corrupt one falls back to a download and the page keeps working', async ({ browser, request }) => {
  const world = await seedWorld(request, { reviewRequired: false });
  const good = await uploadViaApi(
    request,
    world,
    world.owner,
    docx('Policy.docx', world.suffix, 'Leave policy', `Twenty days of leave ${world.suffix}, and <b>not bold</b>.`)
  );
  const bad = await uploadViaApi(request, world, world.owner, corruptDocx('Broken.docx', world.suffix));
  await waitForFileBadge(request, world, world.owner, good, /^Indexed/);
  await waitForFileBadge(request, world, world.owner, bad, /^Indexed/);

  const page = await openAs(browser, world, world.owner);
  await page.goto(`/w/${world.slug}/f/${good}`);
  const preview = page.getByRole('region', { name: 'Preview' });
  await expect(preview.getByRole('heading', { name: 'Leave policy' })).toBeVisible();
  await expect(preview).toContainText(`Twenty days of leave ${world.suffix}`);
  await expect(preview).toContainText('<b>not bold</b>');
  await expect(preview.locator('b')).toHaveCount(0);

  await page.goto(`/w/${world.slug}/f/${bad}`);
  await expect(preview.getByText("This file can't be previewed.")).toBeVisible();
  await expect(preview.getByRole('button', { name: 'Download Broken.docx' })).toBeVisible();
  // The rest of the screen still works.
  await expect(page.getByRole('heading', { name: 'Broken.docx', level: 1 })).toBeVisible();
  await page.getByRole('tab', { name: /^Versions/ }).click();
  await expect(page.getByRole('list', { name: 'Versions' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'File actions' })).toBeVisible();
});

test('a CSV opens as a table of text, and a workbook as tabs; the page number picks the sheet', async ({ browser, request }) => {
  const world = await seedWorld(request, { reviewRequired: false });
  const rows = ['name,note', `Ada,"<img src=x onerror=alert(1)>"`, `Grace,=HYPERLINK("http://evil.example")`, ...Array.from({ length: 1100 }, (_, i) => `row${i},x`)];
  const csv = await uploadViaApi(request, world, world.owner, textFile('People.csv', 'text/csv', rows.join('\n')));
  const book = await uploadViaApi(
    request,
    world,
    world.owner,
    xlsx('Budget.xlsx', world.suffix, [
      { name: 'Income', rows: [['Item', 'Amount'], ['Sales', 1200]] },
      { name: 'Costs', rows: [['Item', 'Amount'], ['Rent', 800], ['Power', 150]] },
    ])
  );
  await waitForFileBadge(request, world, world.owner, csv, /^Indexed/);
  await waitForFileBadge(request, world, world.owner, book, /^Indexed/);

  const page = await openAs(browser, world, world.owner);
  const dialogs: string[] = [];
  page.on('dialog', (d) => {
    dialogs.push(d.message());
    void d.dismiss();
  });
  await page.goto(`/w/${world.slug}/f/${csv}`);
  const preview = page.getByRole('region', { name: 'Preview' });
  await expect(preview.getByRole('columnheader', { name: 'note' })).toBeVisible();
  await expect(preview.getByRole('cell', { name: '<img src=x onerror=alert(1)>' })).toBeVisible();
  await expect(preview.getByRole('cell', { name: '=HYPERLINK("http://evil.example")' })).toBeVisible();
  await expect(preview.locator('img, a')).toHaveCount(0);
  await expect(preview).toContainText('Showing the first 1,000 of 1,103 rows');

  await page.goto(`/w/${world.slug}/f/${book}`);
  await expect(preview.getByRole('tab', { name: 'Income' })).toHaveAttribute('aria-selected', 'true');
  await expect(preview.getByRole('cell', { name: 'Sales' })).toBeVisible();
  await preview.getByRole('tab', { name: 'Costs' }).click();
  await expect(preview.getByRole('cell', { name: 'Rent' })).toBeVisible();

  // A link from search lands on the sheet the text is on.
  await page.goto(`/w/${world.slug}/f/${book}?page=2`);
  await expect(preview.getByRole('tab', { name: 'Costs' })).toHaveAttribute('aria-selected', 'true');
  await expect(preview.getByRole('cell', { name: 'Power' })).toBeVisible();
  expect(dialogs).toEqual([]);
});

test('a PDF opens on the page a search result points to, and a slide deck as text', async ({ browser, request }) => {
  const world = await seedWorld(request, { reviewRequired: false });
  const pages = Array.from({ length: 4 }, (_, i) => `Page ${i + 1} text ${world.suffix}.`);
  const pdf = await uploadViaApi(request, world, world.owner, realPdf('Report.pdf', world.suffix, ...pages));
  await waitForFileBadge(request, world, world.owner, pdf, /^Indexed/);

  const page = await openAs(browser, world, world.owner);
  await page.goto(`/w/${world.slug}/f/${pdf}?page=3`);
  const preview = page.getByRole('region', { name: 'Preview' });
  const input = preview.getByRole('textbox', { name: 'Page number' });
  await expect(input).toHaveValue('3');
  await expect(preview.getByText('/ 4', { exact: true })).toBeVisible();
  await expect(preview.getByRole('button', { name: 'Fit' })).toHaveAttribute('aria-pressed', 'true');
  await preview.getByRole('button', { name: 'Next page' }).click();
  await expect(input).toHaveValue('4');
  await expect(preview.getByRole('button', { name: 'Next page' })).toBeDisabled();
  await input.fill('2');
  await input.press('Enter');
  await expect(input).toHaveValue('2');
  await input.fill('99');
  await input.press('Enter');
  await expect(input).toHaveValue('4');
  await preview.getByRole('button', { name: 'Zoom in' }).click();
  await expect(preview.getByText('125%')).toBeVisible();
  // The page is really drawn: some of the canvas is dark ink.
  const canvas = preview.getByRole('img', { name: 'Page 4 of 4' });
  await expect
    .poll(() =>
      canvas.evaluate((c: HTMLCanvasElement) => {
        const data = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
        for (let i = 0; i < data.length; i += 4) if (data[i]! < 100 && data[i + 3]! > 200) return true;
        return false;
      })
    )
    .toBe(true);

  const deck = await uploadViaApi(
    request,
    world,
    world.owner,
    pptx('Kickoff.pptx', world.suffix, `Welcome slide ${world.suffix}`, 'Agenda slide', 'Questions slide')
  );
  await waitForFileBadge(request, world, world.owner, deck, /^Indexed/);
  await page.goto(`/w/${world.slug}/f/${deck}?page=2`);
  const slides = page.getByRole('region', { name: 'Preview' }).getByRole('list', { name: 'Slides' });
  await expect(slides.getByRole('listitem')).toHaveCount(3);
  await expect(slides).toContainText(`Welcome slide ${world.suffix}`);
  await expect(slides.getByRole('listitem').nth(1)).toContainText('Slide 2');
});

test('a search result for a file opens it on the page the text is on', async ({ browser, request }) => {
  const world = await seedWorld(request, { reviewRequired: false });
  const filler = (word: string) => Array.from({ length: 700 }, (_, i) => `${word}${i}`).join(' ');
  const id = await uploadViaApi(
    request,
    world,
    world.owner,
    realPdf('Long report.pdf', world.suffix, filler('alpha'), `quokka${world.suffix} ${filler('beta')}`, filler('gamma'))
  );
  await waitForFileBadge(request, world, world.owner, id, /^Indexed/);

  const page = await openAs(browser, world, world.owner);
  await page.goto(`/w/${world.slug}/search`);
  await page.getByLabel('Search pages and files').fill(`quokka${world.suffix}`);
  await page.getByLabel('Search pages and files').press('Enter');
  const link = page.getByRole('main').getByRole('link', { name: 'Long report.pdf' }).first();
  await expect(link).toBeVisible();
  const href = await link.getAttribute('href');
  expect(href).toMatch(new RegExp(`/f/${id}\\?page=2$`));
  await link.click();
  await expect(page.getByRole('region', { name: 'Preview' }).getByRole('textbox', { name: 'Page number' })).toHaveValue('2');
});

test('several files at once: a refused one, a copy and a good one do not stop each other; a network error can be retried', async ({
  browser,
  request,
}) => {
  const world = await seedWorld(request, { reviewRequired: false });
  const page = await openAs(browser, world, world.owner);
  await page.goto(`/w/${world.slug}`);
  await expandSpace(page, 'Docs');

  const good = textFile('Good.txt', 'text/plain', `A good file ${world.suffix}.`);
  await uploadThroughMenu(page, 'Docs', [
    good,
    textFile('Page.html', 'text/html', '<html><body>nope</body></html>'),
    textFile('Good copy.txt', 'text/plain', `A good file ${world.suffix}.`),
  ]);
  const panel = uploadPanel(page);
  const rowOf = (name: string) => panel.getByRole('listitem').filter({ hasText: name });
  await expect(rowOf('Good.txt')).toContainText('Indexed · v1');
  await expect(rowOf('Page.html')).toContainText('This file type is not supported for security reasons.');
  await expect(rowOf('Good copy.txt')).toContainText('Already here');
  await expect(treeLink(page, 'Good.txt')).toBeVisible();

  // The network drops once: the file says so, and "Try again" sends it.
  let dropped = false;
  await page.route('**/api/v1/files', async (route) => {
    if (route.request().method() === 'POST' && !dropped) {
      dropped = true;
      await route.abort();
    } else await route.continue();
  });
  await uploadThroughMenu(page, 'Docs', [textFile('Later.txt', 'text/plain', `Sent later ${world.suffix}.`)]);
  await expect(rowOf('Later.txt')).toContainText('Could not reach the server');
  await rowOf('Later.txt').getByRole('button', { name: 'Try Later.txt again' }).click();
  await expect(rowOf('Later.txt')).toContainText('Indexed · v1');

  // Moving around the console does not cancel what is queued.
  await rowOf('Later.txt').getByRole('button', { name: 'Dismiss Later.txt' }).click();
  await expect(rowOf('Later.txt')).toHaveCount(0);
  await rowOf('Page.html').getByRole('button', { name: 'Dismiss Page.html' }).click();
  await expect(rowOf('Page.html')).toHaveCount(0);
});

test('an upload keeps going while the person moves to another screen', async ({ browser, request }) => {
  const world = await seedWorld(request, { reviewRequired: false });
  const page = await openAs(browser, world, world.owner);
  await page.goto(`/w/${world.slug}`);
  await expandSpace(page, 'Docs');
  // Hold the upload long enough to leave the screen while it is in flight.
  await page.route('**/api/v1/files', async (route) => {
    if (route.request().method() === 'POST') await new Promise((r) => setTimeout(r, 1500));
    await route.continue();
  });
  await uploadThroughMenu(page, 'Docs', [textFile('Slow.txt', 'text/plain', `Slow file ${world.suffix}.`)]);
  await expect(uploadPanel(page)).toContainText('Uploading');
  await sidebar(page).getByRole('link', { name: 'Search', exact: true }).click();
  await page.waitForURL(/\/search$/);
  await expect(uploadPanel(page).getByRole('listitem').filter({ hasText: 'Slow.txt' })).toContainText('Indexed · v1');
});

test('a file that cannot be drawn offers its download, and the rest of the screen works', async ({ browser, request }) => {
  const world = await seedWorld(request, { reviewRequired: false });
  const id = await uploadViaApi(request, world, world.owner, fakePdf('Scan.pdf', world.suffix, 'Not really a PDF.'));
  await waitForFileBadge(request, world, world.owner, id, /^Indexed/);
  const page = await openAs(browser, world, world.owner);
  await page.goto(`/w/${world.slug}/f/${id}`);
  const preview = page.getByRole('region', { name: 'Preview' });
  await expect(preview.getByText("This file can't be previewed.")).toBeVisible();
  const [download] = await Promise.all([page.waitForEvent('download'), preview.getByRole('button', { name: 'Download Scan.pdf' }).click()]);
  expect(download.suggestedFilename()).toBe('Scan.pdf');
  await expect(page.getByRole('button', { name: 'File actions' })).toBeVisible();
});

test('a file moves to the Inbox and back, and the sidebar follows', async ({ browser, request }) => {
  const world = await seedWorld(request, { reviewRequired: false });
  const id = await uploadViaApi(request, world, world.owner, textFile('Movable.txt', 'text/plain', `Move me ${world.suffix}.`));
  await waitForFileBadge(request, world, world.owner, id, /^Indexed/);
  const page = await openAs(browser, world, world.owner);
  await page.goto(`/w/${world.slug}/f/${id}`);
  await expandSpace(page, 'Docs');
  await expect(treeLink(page, 'Movable.txt')).toBeVisible();

  await page.getByRole('button', { name: 'File actions' }).click();
  await page.getByRole('button', { name: 'Move…' }).click();
  await page.getByLabel('Move to space').selectOption({ label: 'Inbox' });
  await page.getByRole('button', { name: 'Move file' }).click();
  await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toContainText('Inbox');
  await expandSpace(page, 'Inbox');
  await expect(page.getByRole('complementary', { name: 'Sidebar' }).getByRole('button', { name: 'Collapse Docs' }).locator('xpath=ancestor::li[1]')
    .getByRole('link', { name: /^Movable\.txt/ })).toHaveCount(0);
  await expect(treeLink(page, 'Movable.txt')).toBeVisible();

  await page.getByRole('button', { name: 'File actions' }).click();
  await page.getByRole('button', { name: 'Move…' }).click();
  await page.getByLabel('Move to space').selectOption({ label: 'Docs' });
  await page.getByRole('button', { name: 'Move file' }).click();
  await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toContainText('Docs');
});

test('the add menu works from the keyboard: Enter opens it, Escape closes it and returns focus', async ({ browser, request }) => {
  const world = await seedWorld(request, { reviewRequired: false });
  const page = await openAs(browser, world, world.owner);
  await page.goto(`/w/${world.slug}`);
  const add = sidebar(page).getByRole('button', { name: 'Add to Docs' });
  await expect(add).toBeAttached();
  await add.focus();
  await page.keyboard.press('Enter');
  const menu = sidebar(page).getByRole('menu', { name: 'Add to Docs' });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'New page' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(add).toBeFocused();

  // Tab reaches "Upload file", and Enter opens the file chooser.
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.keyboard.press('Enter')]);
  await chooser.setFiles(textFile('Keys.txt', 'text/plain', `Typed by keys ${world.suffix}.`));
  await expect(uploadPanel(page)).toContainText('Keys.txt');
});

test('on a phone, where the sidebar is closed, uploads still show their progress and refusals', async ({ browser, request }) => {
  const world = await seedWorld(request, { reviewRequired: false });
  const context = await browser.newContext({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 800 } });
  await context.addInitScript((s) => localStorage.setItem('living-wiki.session', JSON.stringify(s)), {
    token: world.owner.token,
    user: world.owner.user,
    tenantId: world.tenantId,
    tenantSlug: world.slug,
  });
  const page = await context.newPage();
  await page.goto(`/w/${world.slug}/s/${world.spaceSlug}`);
  await page.getByLabel('Choose files to upload to Docs').setInputFiles([
    textFile('Phone.txt', 'text/plain', `From a phone ${world.suffix}.`),
    textFile('Page.html', 'text/html', '<html><body>nope</body></html>'),
  ]);
  const panel = uploadPanel(page);
  await expect(panel).toHaveCount(1);
  await expect(panel.getByRole('listitem').filter({ hasText: 'Phone.txt' })).toContainText('Indexed · v1');
  await expect(panel.getByRole('listitem').filter({ hasText: 'Page.html' })).toContainText('not supported');
  await context.close();
});
