import { expect, test, type APIRequestContext } from '@playwright/test';
import { call, openAs, seedWorld } from './support.js';

const short = (id: string) => id.replaceAll('-', '').slice(0, 8);

/** One MCP tool call with an agent token; the result's text. */
async function tool(request: APIRequestContext, token: string, name: string, args: object): Promise<string> {
  const res = await request.post('/mcp', {
    headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream' },
    data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { result: { content: Array<{ text: string }> } };
  return body.result.content.map((c) => c.text).join('\n');
}

test('an agent edits a page over MCP; its owner sees the change and accepts its removal', async ({ browser, request }) => {
  const world = await seedWorld(request, { reviewRequired: false });
  const as = { account: world.owner, tenantId: world.tenantId };
  const page = await call<{ id: string }>(request, '/pages', {
    ...as,
    method: 'POST',
    data: { space_id: world.spaceId, title: 'Pricing', slug: 'pricing', markdown: 'SSO is an add-on.\n\nInvoices go out monthly.' },
  });
  const agent = await call<{ id: string }>(request, '/agents', { ...as, method: 'POST', data: { name: 'Docs bot' } });
  await call(request, `/agents/${agent.id}`, { ...as, method: 'PATCH', data: { always_review: false } });
  await call(request, `/spaces/${world.spaceId}/grants`, { ...as, method: 'POST', data: { principal_type: 'agent', principal_id: agent.id, role: 'editor' } });
  const { token } = await call<{ token: string }>(request, `/agents/${agent.id}/tokens`, {
    ...as,
    method: 'POST',
    data: { name: 'Laptop', scopes: ['read', 'edit'] },
  });

  const read = await tool(request, token, 'kinote_read', { page_id: short(page.id), level: 'full' });
  const sso = /\[([0-9a-f]{8})\] SSO is an add-on/.exec(read)![1]!;
  const invoices = /\[([0-9a-f]{8})\] Invoices go out monthly/.exec(read)![1]!;
  const edited = await tool(request, token, 'kinote_edit', {
    page_id: short(page.id),
    edits: [{ block_id: sso, old: 'an add-on', new: 'included' }, { remove_block_id: invoices }],
  });
  expect(edited).toContain(`• ${sso} — applied`);
  expect(edited).toContain(`• ${invoices} — suggested: removals wait for a person`);

  const owner = await openAs(browser, world, world.owner);
  await owner.goto(`/w/${world.slug}/p/${page.id}`);
  await expect(owner.getByText('SSO is included.')).toBeVisible();
  await owner.getByRole('button', { name: '1 suggestion' }).click();
  const suggestions = owner.getByRole('region', { name: 'Suggestions' });
  await expect(suggestions.getByText(/Suggested by Docs bot/)).toBeVisible();
  await suggestions.getByRole('button', { name: 'Approve removal' }).click();
  await expect(owner.getByText('Invoices go out monthly.')).toHaveCount(0);
});
