import type { SpaceRole, TenantRole } from '@living-wiki/contracts';

// Pure helpers behind the console's screens: what a role may see, how links
// and slugs are built. Kept free of React so they are unit tested.

// --- Roles ----------------------------------------------------------------------

/** Tenant owners and admins manage members, groups, spaces and grants (the server enforces it too). */
export function canAdminister(role: TenantRole): boolean {
  return role === 'owner' || role === 'admin';
}

export interface AdminScreen {
  to:
    | '/w/$tenantSlug/admin/members'
    | '/w/$tenantSlug/admin/groups'
    | '/w/$tenantSlug/admin/spaces'
    | '/w/$tenantSlug/admin/sources';
  label: string;
}

const ADMIN_SCREENS: AdminScreen[] = [
  { to: '/w/$tenantSlug/admin/members', label: 'Members' },
  { to: '/w/$tenantSlug/admin/groups', label: 'Groups' },
  { to: '/w/$tenantSlug/admin/spaces', label: 'Spaces' },
  { to: '/w/$tenantSlug/admin/sources', label: 'Sources' },
];

/** The admin screens a role may open: all of them for owners and admins, none otherwise. */
export function adminScreens(role: TenantRole): AdminScreen[] {
  return canAdminister(role) ? ADMIN_SCREENS : [];
}

/** Granting or changing the owner role is for owners only. */
export function canChangeRole(actorRole: TenantRole, targetRole: TenantRole): boolean {
  return actorRole === 'owner' || targetRole !== 'owner';
}

export const TENANT_ROLES: TenantRole[] = ['owner', 'admin', 'member', 'viewer'];
export const INVITE_ROLES = ['admin', 'member', 'viewer'] as const;

/** Space roles a principal may be granted: agents never hold reviewer or admin. */
export function grantRoleChoices(principalType: 'user' | 'group' | 'agent'): SpaceRole[] {
  return principalType === 'agent' ? ['viewer', 'editor'] : ['viewer', 'editor', 'reviewer', 'admin'];
}

// --- Links and slugs ------------------------------------------------------------

/** The page an invitee opens to accept: `{origin}/accept-invite/{token}`. */
export function inviteLink(origin: string, acceptToken: string): string {
  return `${origin.replace(/\/+$/, '')}/accept-invite/${encodeURIComponent(acceptToken)}`;
}

/** A post-sign-in target from the URL: only a path on this site, anything else becomes `/`. */
export function safeRedirect(target: unknown): string {
  if (typeof target !== 'string' || !target.startsWith('/')) return '/';
  if (target.startsWith('//') || target.includes('\\')) return '/';
  // Control characters: a tab or newline after the first slash makes a
  // browser read `/\t/evil.example` as `//evil.example`; history.pushState
  // throws on some of them.
  if (/[\u0000-\u001f\u007f]/.test(target)) return '/';
  return target;
}

/** A URL slug (`[a-z0-9-]+`) suggested from a display name; empty when nothing usable is left. */
export function slugify(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

// --- Workspaces -----------------------------------------------------------------

interface WorkspaceMembership {
  tenant: { id: string; name: string; slug: string };
  role: TenantRole;
}

/** The workspace to open after sign-in: the last one used while still a member, else the first; null with none. */
export function pickWorkspace<T extends WorkspaceMembership>(
  memberships: readonly T[],
  lastSlug: string | null
): T | null {
  return memberships.find((m) => m.tenant.slug === lastSlug) ?? memberships[0] ?? null;
}
