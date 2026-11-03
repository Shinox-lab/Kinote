// The console under the production Content-Security-Policy and security headers
// (apps/web/security-headers.conf). Only the local stack (pnpm e2e:local) serves the
// built console with those headers; `vite dev` in pnpm e2e cannot run under them.
import { expect, test, type Page } from '@playwright/test';
import { createPageInSpace, editorOf, openAs, seedWorld, typeAtEnd } from './support.js';

test.skip(process.env.E2E_MODE !== 'local', 'only the local stack serves the production headers');

/** Records every CSP violation the page reports, from its first script on. */
async function watchViolations(page: Page): Promise<string[]> {
  const seen: string[] = [];
  await page.exposeFunction('__kinoteCspViolation', (line: string) => void seen.push(line));
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) =>
      (window as unknown as { __kinoteCspViolation(l: string): void }).__kinoteCspViolation(
        `${e.effectiveDirective} blocked ${e.blockedURI}`
      )
    );
  });
  return seen;
}

test('the console shell and its assets carry the security headers', async ({ request }) => {
  const shell = await request.get('/');
  const csp = shell.headers()['content-security-policy'] ?? '';
  expect(csp).toContain("script-src 'self'");
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).not.toContain("'unsafe-eval'");
  expect(shell.headers()['x-frame-options']).toBe('DENY');
  expect(shell.headers()['cross-origin-opener-policy']).toBe('same-origin');
  expect(shell.headers()['x-content-type-options']).toBe('nosniff');

  // No inline script in the shell: script-src 'self' would block it.
  expect(await shell.text()).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);

  const api = await request.get('/api/v1/me');
  expect(api.headers()['x-frame-options']).toBe('DENY');
  expect(api.headers()['content-security-policy']).toContain("default-src 'none'");
});

test('editing a page with text, a link and a drawing breaks no CSP rule', async ({ browser, request }) => {
  const world = await seedWorld(request, { reviewRequired: false });
  const page = await openAs(browser, world, world.owner);
  const violations = await watchViolations(page);

  await createPageInSpace(page, world, 'Under CSP');
  await typeAtEnd(page, 'Plain words and https://example.com/a-link');
  await editorOf(page).click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('/drawing');
  await page.getByRole('option', { name: /^Drawing/ }).click();
  await expect(page.locator('[data-drawing-id] canvas.interactive').last()).toBeVisible();

  await page.reload();
  await expect(editorOf(page)).toContainText('Plain words');
  expect(violations).toEqual([]);
});
