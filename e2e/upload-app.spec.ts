import { expect, test } from '@playwright/test';
import { mcp, stubHost } from './mcpHost.js';
import { call, openAs, seedWorld } from './support.js';

test('a person drops a file into the Kinote panel and it is filed where the agent said', async ({ browser, request, baseURL }) => {
  const world = await seedWorld(request, { reviewRequired: false });
  const as = { account: world.owner, tenantId: world.tenantId };
  const agent = await call<{ id: string }>(request, '/agents', { ...as, method: 'POST', data: { name: 'Docs bot' } });
  await call(request, `/agents/${agent.id}`, { ...as, method: 'PATCH', data: { always_review: false } });
  await call(request, `/spaces/${world.spaceId}/grants`, { ...as, method: 'POST', data: { principal_type: 'agent', principal_id: agent.id, role: 'editor' } });
  const { token } = await call<{ token: string }>(request, `/agents/${agent.id}/tokens`, {
    ...as,
    method: 'POST',
    data: { name: 'Laptop', scopes: ['read', 'capture'] },
  });

  const about = 'The office move plan';
  const opened = await mcp(request, token, 'tools/call', { name: 'kinote_upload', arguments: { about, place_under: world.spaceId } });
  expect(opened.isError ?? false).toBe(false);
  const panelHtml = (await mcp(request, token, 'resources/read', { uri: 'ui://kinote/upload' })).contents[0].text as string;

  const page = await browser.newPage();
  await page.route(`${baseURL}/__stub-host`, (route) =>
    route.fulfill({ contentType: 'text/html', body: stubHost(panelHtml, token, { about, place_under: world.spaceId }) })
  );
  await page.goto('/__stub-host');
  const panel = page.frameLocator('#panel');
  await expect(panel.getByText(about)).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Upload' })).toBeDisabled();

  await panel.locator('input[type=file]').setInputFiles({
    name: 'office-move.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('Office move\n\nThe office moves to Leeds in May. Desks are packed the week before.'),
  });
  await expect(panel.getByText('office-move.txt')).toBeVisible();
  await panel.getByRole('button', { name: 'Upload' }).click();
  await expect(panel.getByText(/Capture [0-9a-f]{8} · /)).toBeVisible({ timeout: 45_000 });
  await expect.poll(() => page.evaluate(() => (window as any).__context.length)).toBeGreaterThan(0);

  const finish = await page.evaluate(() => (window as any).__finish);
  const captureId = finish.structuredContent.capture_id as string;
  // The person sees the file where the receipt says it went.
  await expect
    .poll(async () => (await call<{ capture: { status: string } }>(request, `/captures/${captureId}`, as)).capture.status, { timeout: 45_000 })
    .toBe('done');
  const detail = await call<{ capture: { file: { id: string; name: string } | null; fileOutcome: string | null } }>(request, `/captures/${captureId}`, as);
  expect(detail.capture.file?.name).toBe('office-move.txt');
  expect(detail.capture.fileOutcome).toBe('placed');
  const owner = await openAs(browser, world, world.owner);
  await owner.goto(`/w/${world.slug}/f/${detail.capture.file!.id}`);
  await expect(owner.getByText('office-move.txt').first()).toBeVisible();
});

test('a full 1 MiB chunk passes the proxy in front of /mcp', async ({ request }) => {
  const world = await seedWorld(request, { reviewRequired: false });
  const as = { account: world.owner, tenantId: world.tenantId };
  const agent = await call<{ id: string }>(request, '/agents', { ...as, method: 'POST', data: { name: 'Big file bot' } });
  await call(request, `/spaces/${world.spaceId}/grants`, { ...as, method: 'POST', data: { principal_type: 'agent', principal_id: agent.id, role: 'editor' } });
  const { token } = await call<{ token: string }>(request, `/agents/${agent.id}/tokens`, { ...as, method: 'POST', data: { name: 'Laptop', scopes: ['capture'] } });
  const begin = await mcp(request, token, 'tools/call', { name: 'kinote_upload_begin', arguments: { name: 'big.txt', size: 2_097_152, mime: 'text/plain' } });
  const uploadId = begin.structuredContent.upload_id as string;
  const chunk = await mcp(request, token, 'tools/call', {
    name: 'kinote_upload_chunk',
    arguments: { upload_id: uploadId, index: 0, data: Buffer.alloc(1_048_576, 97).toString('base64') },
  });
  expect(chunk.structuredContent).toEqual({ received_bytes: 1_048_576 });
  await mcp(request, token, 'tools/call', { name: 'kinote_upload_cancel', arguments: { upload_id: uploadId } });
});
