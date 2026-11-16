import { expect, test } from '@playwright/test';
import { call, openAs, seedWorld } from './support.js';

test("an agent's capture shows on its owner's Capture page; the agent switches save", async ({ browser, request }) => {
  const world = await seedWorld(request, { reviewRequired: false });
  const as = { account: world.owner, tenantId: world.tenantId };
  const agent = await call<{ id: string }>(request, '/agents', { ...as, method: 'POST', data: { name: 'Docs bot' } });
  await call(request, `/spaces/${world.spaceId}/grants`, {
    ...as,
    method: 'POST',
    data: { principal_type: 'agent', principal_id: agent.id, role: 'editor' },
  });
  const { token } = await call<{ token: string }>(request, `/agents/${agent.id}/tokens`, {
    ...as,
    method: 'POST',
    data: { name: 'Laptop', scopes: ['read', 'capture'] },
  });

  const res = await request.post('/mcp', {
    headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream' },
    data: {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'kinote_capture', arguments: { text: 'The office moves to Leeds in May.' } },
    },
  });
  expect(res.status()).toBe(200);
  expect(JSON.stringify(await res.json())).toMatch(/Capture [0-9a-f]{8} · /);

  const page = await openAs(browser, world, world.owner);
  await page.goto(`/w/${world.slug}/capture`);
  await expect(page.getByText('via Docs bot')).toBeVisible();

  await page.goto(`/w/${world.slug}/admin/agents`);
  await page.getByRole('button', { name: /^Docs bot/ }).click();
  const panel = page.getByRole('region', { name: 'Agent Docs bot' });
  const review = panel.getByLabel('Always review its changes');
  await expect(review).toBeChecked();
  await review.uncheck();
  await expect
    .poll(async () => (await call<Array<{ id: string; alwaysReview: boolean }>>(request, '/agents', as)).find((a) => a.id === agent.id)?.alwaysReview)
    .toBe(false);
  await page.reload();
  await page.getByRole('button', { name: /^Docs bot/ }).click();
  await expect(page.getByRole('region', { name: 'Agent Docs bot' }).getByLabel('Always review its changes')).not.toBeChecked();

  await page.getByLabel('Agents may answer routing questions').check();
  await expect.poll(async () => (await call<{ agentsMayAnswer: boolean }>(request, '/agents/settings', as)).agentsMayAnswer).toBe(true);
});
