import { expect, test } from '@playwright/test';
import { mcp, stubHost } from './mcpHost.js';
import { call, seedWorld, uploadViaApi } from './support.js';

test("a person approves an agent's waiting edit in the Kinote review panel", async ({ browser, request, baseURL }) => {
  const world = await seedWorld(request, { reviewRequired: false });
  const as = { account: world.owner, tenantId: world.tenantId };
  const page = await call<{ id: string }>(request, '/pages', {
    ...as,
    method: 'POST',
    data: { space_id: world.spaceId, title: 'Office move', slug: 'office-move', markdown: 'The office moves in May.' },
  });
  // The owner's own text is indexed first, so the waiting version is the agent's alone (else self-approval applies).
  await call(request, `/pages/${page.id}/snapshot`, { ...as, method: 'POST' });
  await expect
    .poll(async () => (await call<{ badge: string }>(request, `/pages/${page.id}`, as)).badge, { timeout: 30_000 })
    .toMatch(/^Indexed/);
  // New agents always review: the agent's edit waits for a person.
  const agent = await call<{ id: string }>(request, '/agents', { ...as, method: 'POST', data: { name: 'Docs bot' } });
  await call(request, `/spaces/${world.spaceId}/grants`, { ...as, method: 'POST', data: { principal_type: 'agent', principal_id: agent.id, role: 'editor' } });
  const { token } = await call<{ token: string }>(request, `/agents/${agent.id}/tokens`, {
    ...as,
    method: 'POST',
    data: { name: 'Laptop', scopes: ['read', 'edit'] },
  });
  const edited = await mcp(request, token, 'tools/call', {
    name: 'kinote_edit',
    arguments: { page_id: page.id, edits: [{ after_block_id: null, markdown: 'Desks are packed the week before.' }] },
  });
  expect(edited.content[0].text).toContain('waiting for review');

  const opened = await mcp(request, token, 'tools/call', { name: 'kinote_review', arguments: {} });
  expect(opened.isError ?? false).toBe(false);
  const panelHtml = (await mcp(request, token, 'resources/read', { uri: 'ui://kinote/review' })).contents[0].text as string;

  const host = await browser.newPage();
  await host.route(`${baseURL}/__stub-host`, (route) => route.fulfill({ contentType: 'text/html', body: stubHost(panelHtml, token, {}) }));
  await host.goto('/__stub-host');
  const panel = host.frameLocator('#panel');
  await expect(panel.getByText('New version · Office move')).toBeVisible();
  await expect(panel.getByText('Desks are packed the week before.')).toBeVisible();
  await panel.getByRole('button', { name: 'Approve' }).click();
  await expect(panel.getByText('Approved', { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => host.evaluate(() => (window as any).__context.length)).toBeGreaterThan(0);

  // Nothing waits any more, and the approval was the owner's.
  const reviews = await call<unknown[]>(request, '/reviews', as);
  expect(reviews).toEqual([]);
});

test('the owner approves an agent file version in the panel', async ({ browser, request, baseURL }) => {
  const world = await seedWorld(request, { reviewRequired: false });
  const as = { account: world.owner, tenantId: world.tenantId };
  const fileId = await uploadViaApi(request, world, world.owner, { name: 'budget.csv', mimeType: 'text/csv', buffer: Buffer.from('item,cost\ndesks,100\n') });
  await expect
    .poll(async () => (await call<{ publishedVersion: { number: number } | null }>(request, `/files/${fileId}`, as)).publishedVersion?.number ?? 0, { timeout: 30_000 })
    .toBe(1);
  const agent = await call<{ id: string }>(request, '/agents', { ...as, method: 'POST', data: { name: 'Docs bot' } });
  await call(request, `/spaces/${world.spaceId}/grants`, { ...as, method: 'POST', data: { principal_type: 'agent', principal_id: agent.id, role: 'editor' } });
  const { token } = await call<{ token: string }>(request, `/agents/${agent.id}/tokens`, {
    ...as,
    method: 'POST',
    data: { name: 'Laptop', scopes: ['read', 'edit'] },
  });
  const replaced = await mcp(request, token, 'tools/call', {
    name: 'kinote_replace',
    arguments: { page_id: fileId, base_version: 1, content_text: 'item,cost\ndesks,120\n' },
  });
  expect(replaced.content[0].text).toMatch(/^Replaced: budget\.csv is now v2 \(was v1\)/);
  // The worker reads the new version first; then it waits for the owner.
  await expect.poll(async () => (await call<unknown[]>(request, '/reviews', as)).length, { timeout: 30_000 }).toBe(1);

  const panelHtml = (await mcp(request, token, 'resources/read', { uri: 'ui://kinote/review' })).contents[0].text as string;
  const host = await browser.newPage();
  await host.route(`${baseURL}/__stub-host`, (route) => route.fulfill({ contentType: 'text/html', body: stubHost(panelHtml, token, {}) }));
  await host.goto('/__stub-host');
  const panel = host.frameLocator('#panel');
  await expect(panel.getByText('New version of budget.csv')).toBeVisible({ timeout: 30_000 });
  await panel.getByRole('button', { name: 'Approve' }).click();
  await expect(panel.getByText('Approved', { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(async () => (await call<{ publishedVersion: { number: number } | null }>(request, `/files/${fileId}`, as)).publishedVersion?.number ?? 0, { timeout: 30_000 })
    .toBe(2);
});
