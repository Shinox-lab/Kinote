// pnpm seed:demo: fills a workspace with the Northwind Studio demo content, for trying every feature by hand.
//
//   pnpm seed:demo                                   a new workspace with four new accounts
//   SEED_PASSWORD=… pnpm seed:demo --into <slug> --email <you@…>
//                                                    your existing (empty) workspace; you stand in for Priya
//
// Needs the stack running (docker compose up -d). Base URL: CLIPS_BASE_URL, else http://127.0.0.1:$WEB_HOST_PORT (8081).
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, request as playwrightRequest } from '@playwright/test';
import { call, PASSWORD, uploadViaApi, type Account } from '../../../e2e/support';
import { makeDemoFiles } from './files';
import { seedDemo, type SeedInto } from './seed';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function fail(message: string): never {
  console.error(`seed:demo: ${message}`);
  process.exit(1);
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

function envPort(): string | undefined {
  const file = join(root, '.env');
  if (!existsSync(file)) return undefined;
  return readFileSync(file, 'utf8').match(/^WEB_HOST_PORT=(\d+)/m)?.[1];
}

const baseURL = process.env.CLIPS_BASE_URL ?? `http://127.0.0.1:${process.env.WEB_HOST_PORT ?? envPort() ?? '8081'}`;
const request = await playwrightRequest.newContext({ baseURL });
try {
  await request.get('/api/v1/me', { timeout: 5000 });
} catch {
  fail(`nothing answers at ${baseURL}. Start the stack first: docker compose up -d`);
}

let into: SeedInto | undefined;
const slug = arg('into');
if (slug) {
  const email = arg('email') ?? fail('--into needs --email <your sign-in email>');
  const password = process.env.SEED_PASSWORD ?? fail('set SEED_PASSWORD to your password (kept out of the command line)');
  const res = await call<{ user: Account['user']; session: { token: string } }>(request, '/auth/sign-in', {
    method: 'POST',
    data: { email, password },
  });
  const owner: Account = { token: res.session.token, user: res.user };
  const me = await call<{ memberships: Array<{ tenant: { id: string; slug: string }; role: string }> }>(request, '/me', { account: owner });
  const membership = me.memberships.find((m) => m.tenant.slug === slug) ?? fail(`you are not a member of a workspace with slug "${slug}"`);
  if (membership.role !== 'owner' && membership.role !== 'admin') fail(`you are ${membership.role} of "${slug}"; seeding needs owner or admin`);
  into = { owner, tenantId: membership.tenant.id, slug };
}

console.log(`seed:demo: seeding ${into ? `"${into.slug}"` : 'a new workspace'} at ${baseURL} (takes a minute or two)`);
const demo = await seedDemo(request, { into });

// Two real files in Engineering (no review there), so previews and file search work straight away.
const browser = await chromium.launch();
const files = await makeDemoFiles(browser);
await browser.close();
const world = { suffix: '', tenantId: demo.tenantId, slug: demo.slug, spaceId: demo.spaces.engineering.id, spaceSlug: 'engineering', owner: demo.people.priya };
for (const file of files) await uploadViaApi(request, world, demo.people.priya, file);
await request.dispose();

console.log(`\nDone: ${baseURL}/w/${demo.slug}`);
console.log(`Sign in as any of these (password ${PASSWORD} for the accounts made here):`);
for (const [key, account] of Object.entries(demo.people)) {
  const note = key === 'mei' ? 'reviewer of Clients' : key === 'priya' ? (into ? 'you' : 'owner') : 'editor';
  console.log(`  ${account.user.name.padEnd(14)} ${account.user.email.padEnd(44)} ${note}`);
}
