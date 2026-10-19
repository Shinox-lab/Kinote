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

/** Reply of sign-up and sign-in. */
export const SessionResponseSchema = AuthResponseSchema;
export type SessionResponse = AuthResponse;

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

/** A space as the API publishes it (`createdBy` is the user who made it). Timestamps are ISO 8601 strings. */
export const SpaceSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  name: z.string(),
  slug: z.string(),
  kind: SpaceKindSchema,
  reviewRequired: z.boolean(),
  quietSeconds: z.number().int(),
  humanProtectionSeconds: z.number().int(),
  allowSelfApproval: z.boolean(),
  createdBy: z.string().uuid(),
  createdAt: z.string().datetime(),
  archivedAt: z.string().datetime().nullable(),
});
export type Space = z.infer<typeof SpaceSchema>;

/** Reply of GET and POST /api/v1/spaces, GET /api/v1/spaces/:id and POST .../archive: the space plus the asking actor's role in it. */
export const SpaceResponseSchema = SpaceSchema.extend({
  myRole: SpaceRoleSchema,
});
export type SpaceResponse = z.infer<typeof SpaceResponseSchema>;

/** Reply of GET /api/v1/spaces. */
export const SpaceListSchema = z.array(SpaceResponseSchema);

/** Reply of POST /api/v1/tenants: the new tenant, the creator's membership and the tenant's Inbox space. */
export const CreateTenantResponseSchema = z.object({
  tenant: z.object({ id: z.string().uuid(), name: z.string(), slug: z.string() }),
  membership: z.object({ role: TenantRoleSchema }),
  inboxSpace: SpaceSchema,
});
export type CreateTenantResponse = z.infer<typeof CreateTenantResponseSchema>;

/** Reply of GET /api/v1/members. */
export const MemberListSchema = z.array(MemberSchema);

/** Reply of GET /api/v1/groups. */
export const GroupListSchema = z.array(GroupSchema);

/** Reply of POST /api/v1/groups/:id/members. */
export const GroupMemberResponseSchema = z.object({
  groupId: z.string().uuid(),
  principalType: z.enum(['user', 'agent']),
  principalId: z.string().uuid(),
});
export type GroupMemberResponse = z.infer<typeof GroupMemberResponseSchema>;

/** Reply of GET /api/v1/spaces/:id/grants. */
export const GrantListSchema = z.array(GrantSchema);

/** Reply of POST /api/v1/spaces/:id/grants: the grant as stored (no principal name). */
export const UpsertGrantResponseSchema = z.object({
  spaceId: z.string().uuid(),
  principalType: z.enum(['user', 'agent', 'group']),
  principalId: z.string().uuid(),
  role: SpaceRoleSchema,
});
export type UpsertGrantResponse = z.infer<typeof UpsertGrantResponseSchema>;

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

/** Reply of POST /api/v1/pages: the new page, without its content or any heavy column. */
export const PageSummarySchema = z.object({
  id: z.string().uuid(),
  spaceId: z.string().uuid(),
  parentId: z.string().uuid().nullable(),
  title: z.string(),
  slug: z.string(),
});
export type PageSummary = z.infer<typeof PageSummarySchema>;

/**
 * The document row of a page after a lifecycle change (move, archive,
 * restore, withdraw). `indexedVersionId` is null once nothing is indexed.
 */
export const DocumentSummarySchema = z.object({
  id: z.string().uuid(),
  spaceId: z.string().uuid(),
  parentId: z.string().uuid().nullable(),
  position: z.string(),
  title: z.string(),
  archivedAt: z.string().datetime().nullable(),
  indexedVersionId: z.string().uuid().nullable(),
});
export type DocumentSummary = z.infer<typeof DocumentSummarySchema>;

/** The last actor recorded for a block (`block_activity`). */
export const BlockActivitySchema = z.object({
  blockId: z.string(),
  actorType: z.enum(['user', 'agent']),
  actorId: z.string().uuid(),
  changedAt: z.string().datetime(),
});
export type BlockActivity = z.infer<typeof BlockActivitySchema>;

/**
 * Reply of GET /api/v1/pages/:id: the page as last stored by collab (title,
 * live markdown and BlockNote blocks), its badge and its versions (newest
 * first, as summaries).
 */
export const PageDetailsSchema = z.object({
  id: z.string().uuid(),
  spaceId: z.string().uuid(),
  parentId: z.string().uuid().nullable(),
  title: z.string(),
  slug: z.string(),
  badge: z.string(),
  liveMarkdown: z.string(),
  // BlockNote blocks: every one has an id and a type; the rest (props, content, children) passes through.
  liveBlocks: z.array(z.object({ id: z.string(), type: z.string() }).passthrough()),
  liveChangedSinceSnapshot: z.boolean(),
  agentChangedAt: z.string().datetime().nullable(),
  archivedAt: z.string().datetime().nullable(),
  latestVersion: VersionSummarySchema.nullable(),
  indexedVersion: VersionSummarySchema.nullable(),
  versions: z.array(VersionSummarySchema),
  blockActivity: z.array(BlockActivitySchema),
});
export type PageDetails = z.infer<typeof PageDetailsSchema>;

/** Query of GET /api/v1/reviews: an optional space to narrow the queue to (validated by the handler: a bad id is 404 `space_not_found`). */
export const ReviewQuerySchema = z.object({
  space_id: z.string().optional(),
});

/**
 * One entry of the review queue: a `pending_review` version (summary only: no
 * markdown, blocks or Yjs bytes), its document and space, who contributed, and
 * whether the asking actor may approve it (the same rule approve enforces).
 */
export const ReviewItemSchema = z.object({
  version: VersionSummarySchema,
  document: z.object({
    id: z.string().uuid(),
    title: z.string(),
    spaceId: z.string().uuid(),
    spaceName: z.string(),
  }),
  contributors: z.array(VersionContributorSchema),
  canApprove: z.boolean(),
});
export type ReviewItem = z.infer<typeof ReviewItemSchema>;

/** Reply of GET /api/v1/reviews (oldest version first). */
export const ReviewListSchema = z.array(ReviewItemSchema);

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

/**
 * Params of POST /api/v1/pages/:id/versions/:n/restore: the version number as
 * written in the URL, plain digits (no sign, decimals, exponent or leading
 * zero) and at most the largest Postgres integer. The handler answers a
 * failure with 404 `version_not_found`, the same as a number the page lacks.
 */
export const RestoreVersionParamsSchema = z.object({
  n: z
    .string()
    .regex(/^[1-9][0-9]{0,9}$/)
    .transform(Number)
    .pipe(z.number().int().max(2147483647)),
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

/** One ranked passage of a search: a chunk of an indexed version, with how to cite it. */
export const SearchPassageSchema = z.object({
  chunkId: z.string().uuid(),
  documentId: z.string().uuid(),
  versionId: z.string().uuid(),
  versionNumber: z.number().int(),
  versionTitle: z.string(),
  text: z.string(),
  headingPath: z.array(z.string()),
  blockIds: z.array(z.string()),
  citeAs: z.string(),
  rrfScore: z.number(),
});
export type SearchPassage = z.infer<typeof SearchPassageSchema>;

/** Reply of POST /api/v1/search. */
export const SearchResponseSchema = z.object({
  passages: z.array(SearchPassageSchema),
});
export type SearchResponse = z.infer<typeof SearchResponseSchema>;

export const AskCitationSchema = z.object({
  citeAs: z.string(),
  documentId: z.string().uuid(),
  versionId: z.string().uuid(),
  versionNumber: z.number().int(),
  chunkId: z.string().uuid(),
  blockIds: z.array(z.string()),
  quote: z.string(),
});
export type AskCitation = z.infer<typeof AskCitationSchema>;

/** Reply of POST /api/v1/ask. */
export const AskResponseSchema = z.object({
  answer: z.string(),
  foundRelevant: z.boolean(),
  citations: z.array(AskCitationSchema),
});
export type AskResponse = z.infer<typeof AskResponseSchema>;

// Request bodies as a caller writes them (before defaults and transforms apply).
export type SignUpRequest = z.input<typeof SignUpRequestSchema>;
export type SignInRequest = z.input<typeof SignInRequestSchema>;
export type CreateTenantRequest = z.input<typeof CreateTenantRequestSchema>;
export type InviteMemberRequest = z.input<typeof InviteMemberRequestSchema>;
export type AcceptInvitationRequest = z.input<typeof AcceptInvitationRequestSchema>;
export type CreateSpaceRequest = z.input<typeof CreateSpaceRequestSchema>;
export type UpdateSpaceSettings = z.input<typeof UpdateSpaceSettingsSchema>;
export type UpsertSpaceGrant = z.input<typeof UpsertSpaceGrantSchema>;
export type UpdateMemberRoleRequest = z.input<typeof UpdateMemberRoleRequestSchema>;
export type CreateGroupRequest = z.input<typeof CreateGroupRequestSchema>;
export type AddGroupMemberRequest = z.input<typeof AddGroupMemberRequestSchema>;
export type CreatePageRequest = z.input<typeof CreatePageRequestSchema>;
export type MovePageRequest = z.input<typeof MovePageRequestSchema>;
export type ApproveVersionRequest = z.input<typeof ApproveVersionRequestSchema>;
export type RejectVersionRequest = z.input<typeof RejectVersionRequestSchema>;
export type SearchRequest = z.input<typeof SearchRequestSchema>;
export type AskRequest = z.input<typeof AskRequestSchema>;

/**
 * Internal (API-to-collab) endpoints. Authenticated by the shared
 * `x-internal-secret` header, never exposed to browsers.
 */
export const CollabFlushRequestSchema = z.object({
  documentName: z.string().min(1).max(200),
});
export type CollabFlushRequest = z.infer<typeof CollabFlushRequestSchema>;

/**
 * Closes every live editing connection of a tenant (only those of `user_id`
 * when given), after an admin change that can alter access. The clients
 * reconnect and authenticate again, so the new role applies at once.
 */
export const CollabRevokeRequestSchema = z.object({
  tenant_id: z.string().uuid(),
  user_id: z.string().uuid().optional(),
});
export type CollabRevokeRequest = z.infer<typeof CollabRevokeRequestSchema>;

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
