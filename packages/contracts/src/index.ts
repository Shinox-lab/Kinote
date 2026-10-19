import { z } from 'zod';

export * from './errors.js';

export const TenantRoleSchema = z.enum(['owner', 'admin', 'member', 'viewer']);
export type TenantRole = z.infer<typeof TenantRoleSchema>;

export const SpaceRoleSchema = z.enum(['viewer', 'editor', 'reviewer', 'admin']);
export type SpaceRole = z.infer<typeof SpaceRoleSchema>;

export const SpaceKindSchema = z.enum(['normal', 'inbox']);
export type SpaceKind = z.infer<typeof SpaceKindSchema>;

export const VersionStatusSchema = z.enum([
  'extracting',
  'pending_review',
  'indexing',
  'indexed',
  'superseded',
  'rejected',
  'withdrawn',
  'failed',
  'stored',
]);
export type VersionStatus = z.infer<typeof VersionStatusSchema>;

export const VersionReasonSchema = z.enum([
  'quiet',
  'submit',
  'agent',
  'restore',
  'upload',
  'source',
  'transcript',
]);
export type VersionReason = z.infer<typeof VersionReasonSchema>;

export const AuditEventTypeSchema = z.enum([
  'tenant.created',
  'member.invited',
  'member.role_changed',
  'member.joined',
  'member.removed',
  'agent.created',
  'agent.token_issued',
  'agent.tool_called',
  'space.created',
  'space.settings_changed',
  'space.grant_changed',
  'space.archived',
  'page.created',
  'page.moved',
  'page.archived',
  'page.restored',
  'page.withdrawn',
  'version.created',
  'version.approved',
  'version.rejected',
  'version.indexed',
  'version.restored',
  'version.retried',
  'file.uploaded',
  'file.moved',
  'document.purged',
  'source.created',
  'source.linked',
  'source.unlinked',
  'source.mapping_changed',
  'source.item_deleted',
  'flag.raised',
  'flag.resolved',
  'export.created',
]);
export type AuditEventType = z.infer<typeof AuditEventTypeSchema>;

// --- Auth -------------------------------------------------------------------
// Request bodies are snake_case (none of these need it); reply bodies are camelCase.

const EmailSchema = z
  .string()
  .trim()
  .max(254)
  .email()
  .transform((email) => email.toLowerCase());

export const SignUpRequestSchema = z.object({
  email: EmailSchema,
  name: z.string().trim().min(1).max(120),
  password: z.string().min(10).max(1024),
});

export const SignInRequestSchema = z.object({
  email: EmailSchema,
  password: z.string().min(1).max(1024),
});

export const AuthUserSchema = z.object({
  id: z.string().uuid(),
  email: z.string(),
  name: z.string(),
});
export type AuthUser = z.infer<typeof AuthUserSchema>;

export const SessionTokenSchema = z.object({
  token: z.string(),
  expiresAt: z.string().datetime(),
});

export const AuthResponseSchema = z.object({
  user: AuthUserSchema,
  session: SessionTokenSchema,
});
export type AuthResponse = z.infer<typeof AuthResponseSchema>;

export const MeResponseSchema = z.object({
  user: AuthUserSchema,
  memberships: z.array(
    z.object({
      tenant: z.object({ id: z.string().uuid(), name: z.string(), slug: z.string() }),
      role: TenantRoleSchema,
    })
  ),
});
export type MeResponse = z.infer<typeof MeResponseSchema>;

// The owner is the signed-in user; it is never taken from the request body.
export const CreateTenantRequestSchema = z.object({
  name: z.string().trim().min(1).max(120),
  slug: z.string().regex(/^[a-z0-9-]+$/).min(1).max(80),
});

// --- Invitations --------------------------------------------------------------
// The invitee accepts with a token; the owner role is never invitable.
export const InviteMemberRequestSchema = z.object({
  email: EmailSchema,
  role: z.enum(['admin', 'member', 'viewer']),
});

export const AcceptInvitationRequestSchema = z.object({
  token: z.string().max(512),
});

export const InviteMemberResponseSchema = z.object({
  invitation: z.object({
    id: z.string().uuid(),
    email: z.string(),
    role: z.enum(['admin', 'member', 'viewer']),
    expiresAt: z.string().datetime(),
  }),
  acceptToken: z.string(),
});
export type InviteMemberResponse = z.infer<typeof InviteMemberResponseSchema>;

export const AcceptInvitationResponseSchema = z.object({
  tenant: z.object({ id: z.string().uuid(), name: z.string(), slug: z.string() }),
  role: TenantRoleSchema,
});
export type AcceptInvitationResponse = z.infer<typeof AcceptInvitationResponseSchema>;

export const CreateSpaceRequestSchema = z.object({
  name: z.string().trim().min(1).max(120),
  slug: z.string().regex(/^[a-z0-9-]+$/).min(1).max(80),
  review_required: z.boolean().default(false),
  quiet_seconds: z.number().int().min(10).max(3600).default(120),
  human_protection_seconds: z.number().int().min(0).max(86400).default(300),
  allow_self_approval: z.boolean().default(false),
});

export const UpdateSpaceSettingsSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  review_required: z.boolean().optional(),
  quiet_seconds: z.number().int().min(10).max(3600).optional(),
  human_protection_seconds: z.number().int().min(0).max(86400).optional(),
  allow_self_approval: z.boolean().optional(),
});

export const UpsertSpaceGrantSchema = z.object({
  principal_type: z.enum(['user', 'agent', 'group']),
  principal_id: z.string().uuid(),
  role: SpaceRoleSchema,
});

// --- Members, groups and grants administration -----------------------------------
// Request bodies are snake_case; reply bodies are camelCase.

export const UpdateMemberRoleRequestSchema = z.object({
  role: TenantRoleSchema,
});

export const CreateGroupRequestSchema = z.object({
  name: z.string().trim().min(1).max(120),
});

export const AddGroupMemberRequestSchema = z.object({
  principal_type: z.enum(['user', 'agent']),
  principal_id: z.string().uuid(),
});

export const MemberSchema = z.object({
  userId: z.string().uuid(),
  email: z.string(),
  name: z.string(),
  role: TenantRoleSchema,
});
export type Member = z.infer<typeof MemberSchema>;

export const GroupSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  memberCount: z.number().int().min(0),
});
export type Group = z.infer<typeof GroupSchema>;

export const GrantSchema = z.object({
  principalType: z.enum(['user', 'agent', 'group']),
  principalId: z.string().uuid(),
  principalName: z.string(),
  role: SpaceRoleSchema,
});
export type Grant = z.infer<typeof GrantSchema>;

export const SpaceResponseSchema = z.object({
  id: z.string().uuid(),
  tenant_id: z.string().uuid(),
  name: z.string(),
  slug: z.string(),
  kind: SpaceKindSchema,
  review_required: z.boolean(),
  quiet_seconds: z.number(),
  human_protection_seconds: z.number(),
  allow_self_approval: z.boolean(),
  my_role: SpaceRoleSchema,
  created_at: z.string().datetime(),
  archived_at: z.string().datetime().nullable(),
});

export const CreatePageRequestSchema = z.object({
  space_id: z.string().uuid(),
  parent_id: z.string().uuid().nullable().default(null),
  title: z.string().trim().min(1).max(200),
  slug: z.string().regex(/^[a-z0-9-]+$/).min(1).max(120),
  markdown: z.string().default(''),
});

export const MovePageRequestSchema = z.object({
  target_space_id: z.string().uuid(),
  target_parent_id: z.string().uuid().nullable().default(null),
  position: z.string().default('a0'),
});

export const RejectVersionRequestSchema = z.object({
  review_note: z.string().trim().min(1).max(300),
});

export const ApproveVersionRequestSchema = z.object({
  review_note: z.string().trim().max(300).optional(),
});

/**
 * A version without its heavy columns (markdown, blocks, Yjs snapshot), as
 * GET /api/v1/pages/:id lists them. Timestamps are ISO 8601 strings.
 */
export const VersionSummarySchema = z.object({
  id: z.string().uuid(),
  number: z.number().int(),
  status: VersionStatusSchema,
  reason: VersionReasonSchema,
  createdByType: z.enum(['user', 'agent', 'connector']),
  createdBy: z.string(),
  createdAt: z.string(),
  reviewedBy: z.string().nullable(),
  reviewedAt: z.string().nullable(),
  reviewNote: z.string().nullable(),
  indexedAt: z.string().nullable(),
  error: z.string().nullable(),
});
export type VersionSummary = z.infer<typeof VersionSummarySchema>;

/** A principal that contributed to a version, with the name shown in history. */
export const VersionContributorSchema = z.object({
  type: z.enum(['user', 'agent']),
  id: z.string().uuid(),
  name: z.string(),
  isAgent: z.boolean(),
});
export type VersionContributor = z.infer<typeof VersionContributorSchema>;

/**
 * Reply of GET /api/v1/versions/:id: the summary plus the stored markdown (the
 * reviewed form), the stored BlockNote blocks and who contributed. Never
 * carries the Yjs snapshot bytes.
 */
export const VersionDetailSchema = VersionSummarySchema.extend({
  markdown: z.string().nullable(),
  blocks: z.array(z.unknown()),
  contributors: z.array(VersionContributorSchema),
});
export type VersionDetail = z.infer<typeof VersionDetailSchema>;

/**
 * One block in a diff, aligned by block id. `before` is the old text
 * (`changed`, `removed`), `after` the new text (`added`, `changed`,
 * `unchanged`). `author` is the last actor recorded for the block
 * (`block_activity`), set for `added` and `changed` only.
 */
export const BlockDiffEntrySchema = z.object({
  blockId: z.string(),
  change: z.enum(['added', 'removed', 'changed', 'unchanged']),
  before: z.string().optional(),
  after: z.string().optional(),
  author: z.object({ type: z.enum(['user', 'agent']), id: z.string() }).optional(),
});
export type BlockDiffEntry = z.infer<typeof BlockDiffEntrySchema>;

/** Reply of GET /api/v1/pages/:id/versions (newest first). */
export const VersionListSchema = z.array(VersionSummarySchema);

/** Reply of GET /api/v1/pages/:id/changes, /compare and GET /api/v1/versions/:id/diff. */
export const BlockDiffSchema = z.array(BlockDiffEntrySchema);

/** Query of GET /api/v1/pages/:id/compare: two version numbers of the page. */
export const CompareQuerySchema = z.object({
  // max: the largest Postgres integer, so an oversize value is a 400, not a database error.
  from: z.coerce.number().int().positive().max(2147483647),
  to: z.coerce.number().int().positive().max(2147483647),
});

/** Reply of POST /api/v1/versions/:id/retry (no request body): the summary plus its document. */
export const RetryVersionResponseSchema = VersionSummarySchema.extend({
  documentId: z.string().uuid(),
});
export type RetryVersionResponse = z.infer<typeof RetryVersionResponseSchema>;

/**
 * One document in a space's tree (or archived list), as
 * GET /api/v1/spaces/:id/tree and /archived list them. `slug` is null for a
 * document that is not a page (files).
 */
export const TreeNodeSchema = z.object({
  id: z.string().uuid(),
  parentId: z.string().uuid().nullable(),
  position: z.string(),
  kind: z.enum(['page', 'file']),
  title: z.string(),
  slug: z.string().nullable(),
});
export type TreeNode = z.infer<typeof TreeNodeSchema>;

/** Reply of GET /api/v1/spaces/:id/tree and GET /api/v1/spaces/:id/archived. */
export const TreeResponseSchema = z.object({
  nodes: z.array(TreeNodeSchema),
});
export type TreeResponse = z.infer<typeof TreeResponseSchema>;

export const CollabTokenResponseSchema = z.object({
  token: z.string(),
  expiresAt: z.string(),
  access: z.enum(['read', 'write']),
});
export type CollabTokenResponse = z.infer<typeof CollabTokenResponseSchema>;

export const SearchRequestSchema = z.object({
  query: z.string().trim().min(1).max(500),
  space_ids: z.array(z.string().uuid()).optional(),
  limit: z.number().int().min(1).max(50).default(10),
});

export const AskRequestSchema = z.object({
  question: z.string().trim().min(1).max(1000),
  space_ids: z.array(z.string().uuid()).optional(),
});

/**
 * Internal (API-to-collab) endpoints. Authenticated by the shared
 * `x-internal-secret` header, never exposed to browsers.
 */
export const CollabFlushRequestSchema = z.object({
  documentName: z.string().min(1).max(200),
});
export type CollabFlushRequest = z.infer<typeof CollabFlushRequestSchema>;

/**
 * Replaces a live page's BlockNote content and title. `source` decides the
 * attribution: an `agent` change marks the page agent-changed, a `restore`
 * never does. The two are tied: only an agent makes an `agent` change, and a
 * restore is always a person's. At least one block (an empty block group is
 * not a valid BlockNote document).
 */
export const CollabReplaceBlocksRequestSchema = z
  .object({
    documentName: z.string().min(1).max(200),
    title: z.string().trim().min(1).max(200),
    blocks: z.array(z.record(z.unknown())).min(1).max(10_000),
    actor: z.object({
      type: z.enum(['user', 'agent']),
      id: z.string().uuid(),
    }),
    source: z.enum(['restore', 'agent']),
  })
  .superRefine((req, ctx) => {
    const expected = req.source === 'agent' ? 'agent' : 'user';
    if (req.actor.type !== expected) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['actor', 'type'],
        message: `A ${req.source} change must be made by a${expected === 'agent' ? 'n agent' : ' user'}.`,
      });
    }
  });
export type CollabReplaceBlocksRequest = z.infer<typeof CollabReplaceBlocksRequestSchema>;
