import type { SpaceRole } from '@kinote/contracts';

// What each space role means, in one place: the grant pickers, the badges and
// the Roles screen all read from here. The rules mirror `requireSpaceRole` in
// packages/core/src/permissions.ts; a role includes everything the ones before it can do.

export const SPACE_ROLES: readonly SpaceRole[] = ['viewer', 'editor', 'reviewer', 'admin'];

export const ROLE_LABEL: Record<SpaceRole, string> = {
  viewer: 'Viewer',
  editor: 'Editor',
  reviewer: 'Reviewer',
  admin: 'Admin',
};

export const ROLE_SUMMARY: Record<SpaceRole, string> = {
  viewer: 'Reads pages and files, searches and asks.',
  editor: 'Writes pages and uploads files.',
  reviewer: 'Approves or rejects changes, restores versions.',
  admin: 'Manages access, settings and archiving.',
};

export interface Capability {
  label: string;
  /** The lowest role that can do it. */
  from: SpaceRole;
  note?: string;
}

export interface CapabilityGroup {
  title: string;
  items: Capability[];
}

export const CAPABILITY_GROUPS: CapabilityGroup[] = [
  {
    title: 'Read',
    items: [
      { label: 'Read pages and files', from: 'viewer' },
      { label: 'Search and Ask over the space', from: 'viewer' },
    ],
  },
  {
    title: 'Write',
    items: [
      { label: 'Create and edit pages', from: 'editor', note: 'Live co-editing.' },
      { label: 'Upload, edit and move files', from: 'editor' },
      { label: 'Submit a change for review', from: 'editor' },
    ],
  },
  {
    title: 'Review',
    items: [
      { label: 'Approve or reject changes', from: 'reviewer', note: 'Only matters where review is on.' },
      { label: 'Restore an earlier version', from: 'reviewer' },
      { label: 'Withdraw a page or file from search', from: 'reviewer' },
    ],
  },
  {
    title: 'Manage',
    items: [
      { label: 'Archive or restore pages and files', from: 'admin' },
      { label: 'Change who has access', from: 'admin' },
      { label: 'Change space settings', from: 'admin' },
    ],
  },
];

const RANK: Record<SpaceRole, number> = { viewer: 1, editor: 2, reviewer: 3, admin: 4 };

export function roleCan(role: SpaceRole, capability: Capability): boolean {
  return RANK[role] >= RANK[capability.from];
}

export interface TenantRoleInfo {
  role: 'owner' | 'admin' | 'member' | 'viewer';
  label: string;
  summary: string;
}

/** Workspace roles sit above space roles: owners and admins act as admin in every space, a viewer is read-only everywhere. */
export const TENANT_ROLE_INFO: TenantRoleInfo[] = [
  { role: 'owner', label: 'Owner', summary: 'Everything an admin does, plus deleting the workspace. Admin in every space.' },
  { role: 'admin', label: 'Admin', summary: 'Manages members, groups, spaces and sources. Admin in every space, archived ones included.' },
  { role: 'member', label: 'Member', summary: 'Gets the access each space grants them, directly or through a group.' },
  { role: 'viewer', label: 'Viewer', summary: 'Read-only in every space, whatever their grants say.' },
];

export const ROLE_RULES: string[] = [
  'Someone with several grants (direct, or through groups) gets the highest of them.',
  'Agents can be Viewer or Editor. They never approve: an agent’s change always needs a person.',
  'Where a space requires review, a person’s edit stays out of search until a reviewer approves it.',
  'Everyone can use their own Inbox. Its items are private to whoever created them, and to workspace admins.',
];
