import { describe, expect, test } from 'vitest';
import {
  adminScreens,
  canAdminister,
  canChangeRole,
  expiryLabel,
  grantRoleChoices,
  inviteLink,
  isUuid,
  pickWorkspace,
  safeRedirect,
  slugify,
} from '../src/lib/console.js';

describe('role gating', () => {
  test('only tenant owners and admins reach the admin screens', () => {
    expect(canAdminister('owner')).toBe(true);
    expect(canAdminister('admin')).toBe(true);
    expect(canAdminister('member')).toBe(false);
    expect(canAdminister('viewer')).toBe(false);
  });

  test('adminScreens lists members, groups, spaces, sources and roles for admins, Workspace too for owners, and nothing for others', () => {
    expect(adminScreens('admin').map((s) => s.to)).toEqual([
      '/w/$tenantSlug/admin/members',
      '/w/$tenantSlug/admin/groups',
      '/w/$tenantSlug/admin/spaces',
      '/w/$tenantSlug/admin/sources',
      '/w/$tenantSlug/admin/roles',
    ]);
    expect(adminScreens('owner').map((s) => s.to)).toEqual([
      ...adminScreens('admin').map((s) => s.to),
      '/w/$tenantSlug/admin/workspace',
    ]);
    expect(adminScreens('member')).toEqual([]);
    expect(adminScreens('viewer')).toEqual([]);
  });

  test('an admin cannot change an owner; an owner can change anyone', () => {
    expect(canChangeRole('owner', 'owner')).toBe(true);
    expect(canChangeRole('admin', 'owner')).toBe(false);
    expect(canChangeRole('admin', 'member')).toBe(true);
  });

  test('agents can hold viewer or editor grants only', () => {
    expect(grantRoleChoices('agent')).toEqual(['viewer', 'editor']);
    expect(grantRoleChoices('user')).toEqual(['viewer', 'editor', 'reviewer', 'admin']);
    expect(grantRoleChoices('group')).toEqual(['viewer', 'editor', 'reviewer', 'admin']);
  });
});

describe('inviteLink', () => {
  test('builds the accept URL from the origin and the token', () => {
    expect(inviteLink('https://wiki.example.test', 'tenant.secret_-x')).toBe(
      'https://wiki.example.test/accept-invite/tenant.secret_-x'
    );
  });

  test('escapes characters that would break the path', () => {
    expect(inviteLink('http://localhost:5173', 'a/b c?d#e')).toBe(
      'http://localhost:5173/accept-invite/a%2Fb%20c%3Fd%23e'
    );
  });

  test('drops a trailing slash on the origin', () => {
    expect(inviteLink('http://localhost:5173/', 't.s')).toBe('http://localhost:5173/accept-invite/t.s');
  });
});

describe('safeRedirect', () => {
  test('keeps a same-origin path', () => {
    expect(safeRedirect('/accept-invite/t.s')).toBe('/accept-invite/t.s');
    expect(safeRedirect('/w/acme?space=inbox')).toBe('/w/acme?space=inbox');
  });

  test.each([
    ['an absolute URL', 'https://evil.example/x'],
    ['a protocol-relative URL', '//evil.example/x'],
    ['a backslash trick', '/\\evil.example'],
    ['a tab trick', '/\t/evil.example'],
    ['a newline', '/w/acme\n'],
    ['a NUL', '/w/\u0000acme'],
    ['a DEL', '/w/acme\u007f'],
    ['a relative path', 'w/acme'],
    ['an empty string', ''],
    ['a non-string', 42],
    ['undefined', undefined],
  ])('falls back to / for %s', (_label, value) => {
    expect(safeRedirect(value)).toBe('/');
  });
});

describe('workspace helpers', () => {
  const memberships = [
    { tenant: { id: 'a', name: 'Acme', slug: 'acme' }, role: 'owner' as const },
    { tenant: { id: 'b', name: 'Beta', slug: 'beta' }, role: 'member' as const },
  ];

  test('pickWorkspace prefers the last opened workspace while the user is still a member', () => {
    expect(pickWorkspace(memberships, 'beta')?.tenant.slug).toBe('beta');
    expect(pickWorkspace(memberships, 'gone')?.tenant.slug).toBe('acme');
    expect(pickWorkspace(memberships, null)?.tenant.slug).toBe('acme');
    expect(pickWorkspace([], 'acme')).toBeNull();
  });

  test('slugify makes a valid slug from a name', () => {
    expect(slugify('Acme Corp!')).toBe('acme-corp');
    expect(slugify('  Équipe  Produit ')).toBe('equipe-produit');
    expect(slugify('---')).toBe('');
  });

  test('isUuid accepts a UUID and nothing else', () => {
    expect(isUuid('3f1c2b0e-6d2c-4a52-9c83-8f1f7c2b1a11')).toBe(true);
    expect(isUuid('not-a-uuid')).toBe(false);
    expect(isUuid('')).toBe(false);
  });
});

describe('expiryLabel', () => {
  const now = Date.parse('2026-10-31T12:00:00Z');
  const at = (ms: number) => new Date(now + ms).toISOString();
  test('counts down in days, then hours, then says expired', () => {
    expect(expiryLabel(at(6.5 * 86_400_000), now)).toBe('Expires in 6 days');
    expect(expiryLabel(at(1.2 * 86_400_000), now)).toBe('Expires in 1 day');
    expect(expiryLabel(at(5 * 3_600_000), now)).toBe('Expires in 5 hours');
    expect(expiryLabel(at(10 * 60_000), now)).toBe('Expires in under an hour');
    expect(expiryLabel(at(-1000), now)).toBe('Expired');
    expect(expiryLabel('not a date', now)).toBe('Expired');
  });
});
