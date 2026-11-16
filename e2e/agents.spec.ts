import { expect, test } from '@playwright/test';
import { call, openAs, seedWorld } from './support.js';

test('an owner creates an agent, grants it a space, issues a Read token once, then revokes it', async ({ browser, request }) => {
  const world = await seedWorld(request, { reviewRequired: false });
  const page = await openAs(browser, world, world.owner);
  await page.goto(`/w/${world.slug}/admin/agents`);
  await expect(page.getByRole('link', { name: 'Agents' })).toBeVisible();

  await page.getByRole('button', { name: 'Add agent' }).click();
  const form = page.locator('form').filter({ has: page.getByRole('heading', { name: 'Add an agent' }) });
  await form.getByLabel('Agent name').fill('Docs bot');
  await form.getByRole('button', { name: 'Add agent' }).click();

  const panel = page.getByRole('region', { name: 'Agent Docs bot' });
  await expect(panel).toContainText('Active');

  // Viewer on Docs, saved through the grants routes.
  await panel.getByLabel('Access to Docs').selectOption('viewer');
  await expect
    .poll(async () => {
      const grants = await call<Array<{ principalType: string; role: string }>>(request, `/spaces/${world.spaceId}/grants`, {
        account: world.owner,
        tenantId: world.tenantId,
      });
      return grants.find((g) => g.principalType === 'agent')?.role ?? null;
    })
    .toBe('viewer');

  await panel.getByLabel('Token name').fill('Claude Code');
  await expect(panel.getByLabel('Read')).toBeChecked();
  await panel.getByRole('button', { name: 'New token' }).click();
  const dialog = page.getByRole('dialog', { name: 'Token for Docs bot' });
  await expect(dialog).toContainText('This token is shown once. Store it now.');
  const token = await dialog.getByLabel('The new token').inputValue();
  expect(token).toMatch(/^lwagt_[0-9a-f]{32}\./);
  const origin = new URL(page.url()).origin;
  await expect(dialog).toContainText(`claude mcp add --transport http kinote ${origin}/mcp --header "Authorization: Bearer ${token}"`);
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(dialog).toHaveCount(0);
  expect(await page.content()).not.toContain(token);

  const row = panel.getByRole('list', { name: 'Tokens of Docs bot' }).getByRole('listitem');
  await expect(row).toContainText('Claude Code');
  await expect(row).toContainText(`${token.split('.')[1]!.slice(0, 8)}…`);
  await expect(row).toContainText('read');
  await row.getByRole('button', { name: 'Revoke Claude Code' }).click();
  await row.getByRole('button', { name: 'Confirm revoking Claude Code' }).click();
  await expect(row).toContainText('Revoked');
});
