import type { LoadConfig } from './config.js';
import type { LoadAccount } from './editor.js';
import { mapLimit, sleep } from './util.js';

export interface SeededPage {
  pageId: string;
  spaceId: string;
  /** The people who may write it: the owner first, then the invited editors. */
  editors: LoadAccount[];
}

export interface SeededWorkspace {
  tenantId: string;
  slug: string;
  pages: SeededPage[];
}

interface ApiOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  account?: LoadAccount;
  tenantId?: string;
  body?: unknown;
}

/** A tenant-scoped api call, waiting out the auth rate limit instead of failing the seed. */
async function api<T>(config: LoadConfig, path: string, options: ApiOptions = {}): Promise<T> {
  const method = options.method ?? 'GET';
  for (let attempt = 0; attempt < 8; attempt++) {
    const res = await fetch(`${config.apiUrl}/api/v1${path}`, {
      method,
      headers: {
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(options.account ? { authorization: `Bearer ${options.account.token}` } : {}),
        ...(options.tenantId ? { 'x-tenant-id': options.tenantId } : {}),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    const text = await res.text();
    if (res.ok) return (text === '' ? null : JSON.parse(text)) as T;
    if (res.status === 429) {
      const seconds = Number(res.headers.get('retry-after') ?? '1');
      await sleep(Math.max(500, (Number.isFinite(seconds) ? seconds : 1) * 1000));
      continue;
    }
    throw new Error(`${method} ${path} -> ${res.status} ${text}`);
  }
  throw new Error(`${method} ${path} -> still rate limited after 8 attempts`);
}

async function signUp(config: LoadConfig, role: string, suffix: string): Promise<LoadAccount> {
  const email = `load-${role}-${suffix}@example.test`;
  const result = await api<{ user: LoadAccount['user']; session: { token: string } }>(config, '/auth/sign-up', {
    method: 'POST',
    body: { email, name: `Load ${role} ${suffix}`, password: config.password },
  });
  return { token: result.session.token, user: result.user };
}

/** One workspace: an owner, the other editors invited and granted, and the pages they share. */
export async function seedWorkspace(config: LoadConfig, index: number): Promise<SeededWorkspace> {
  const suffix = `${config.runId}-${index}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const tenantSlug = `load-${suffix}`;
  const owner = await signUp(config, 'owner', suffix);
  const { tenant } = await api<{ tenant: { id: string } }>(config, '/tenants', {
    method: 'POST',
    account: owner,
    body: { name: `Load ${suffix}`, slug: tenantSlug },
  });
  const space = await api<{ id: string }>(config, '/spaces', {
    method: 'POST',
    account: owner,
    tenantId: tenant.id,
    body: { name: 'Docs', slug: 'docs', review_required: false },
  });

  const editors: LoadAccount[] = [owner];
  for (let i = 1; i < config.editorsPerWorkspace; i++) {
    const member = await signUp(config, `editor-${i}`, suffix);
    const invite = await api<{ acceptToken: string }>(config, '/invitations', {
      method: 'POST',
      account: owner,
      tenantId: tenant.id,
      body: { email: member.user.email, role: 'member' },
    });
    await api(config, '/invitations/accept', {
      method: 'POST',
      account: member,
      body: { token: invite.acceptToken },
    });
    await api(config, `/spaces/${space.id}/grants`, {
      method: 'POST',
      account: owner,
      tenantId: tenant.id,
      body: { principal_type: 'user', principal_id: member.user.id, role: 'editor' },
    });
    editors.push(member);
  }

  const pages: SeededPage[] = [];
  for (let p = 0; p < config.pagesPerWorkspace; p++) {
    const page = await api<{ id: string }>(config, '/pages', {
      method: 'POST',
      account: owner,
      tenantId: tenant.id,
      body: {
        space_id: space.id,
        title: `Load page ${p}`,
        slug: `load-${p}`,
        markdown: pageMarkdown(p, config.markdownParagraphs),
      },
    });
    pages.push({ pageId: page.id, spaceId: space.id, editors });
  }

  return { tenantId: tenant.id, slug: tenantSlug, pages };
}

/** Seeds every workspace, at most `seedConcurrency` at a time. */
export async function seedAll(
  config: LoadConfig,
  onProgress?: (done: number, total: number) => void
): Promise<SeededWorkspace[]> {
  const indices = Array.from({ length: config.workspaces }, (_, index) => index);
  return mapLimit(indices, config.seedConcurrency, async (index) => {
    const workspace = await seedWorkspace(config, index);
    onProgress?.(index + 1, config.workspaces);
    return workspace;
  });
}

/** Enough text that a page's Yjs state is not trivially small. */
function pageMarkdown(page: number, paragraphs: number): string {
  const sentence =
    'The quick brown fox jumps over the lazy dog while the team reviews the page and writes down what changed.';
  const lines = [`# Load page ${page}`, ''];
  for (let i = 0; i < paragraphs; i++) lines.push(`${sentence} ${sentence}`, '');
  return lines.join('\n');
}
