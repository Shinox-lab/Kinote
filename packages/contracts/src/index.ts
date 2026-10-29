import { z } from 'zod';

export * from './errors.js';
export * from './editor.js';
export * from './collections.js';
import { CollectionSchema } from './collections.js';

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
  'capture',
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
  'page.renamed',
  'page.archived',
  'page.restored',
  'page.withdrawn',
  'collection.created',
  'collection.removed',
  'collection.field_added',
  'collection.field_changed',
  'collection.field_removed',
  'capture.created',
  'capture.routed',
  'capture.question_asked',
  'capture.answered',
  'capture.change_undone',
  'capture.change_moved',
  'capture.fact_placed',
  'capture.document_created',
  'capture.document_placed',
  'capture.document_moved',
  'comment.created',
  'comment.updated',
  'comment.deleted',
  'thread.resolved',
  'thread.reopened',
  'thread.deleted',
  'suggestion.accepted',
  'suggestion.declined',
  'version.created',
  'version.approved',
  'version.rejected',
  'version.indexed',
  'version.restored',
  'version.retried',
  'file.uploaded',
  'file.moved',
  'file.renamed',
  'file.extracted',
  'file.withdrawn',
  'file.archived',
  'file.restored',
  'document.purged',
  'source.created',
  'source.linked',
  'source.unlinked',
  'source.mapping_changed',
  'source.item_deleted',
  'source.updated',
  'source.token_issued',
  'source.token_revoked',
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

/**
 * Body of PATCH /api/v1/pages/:id and PATCH /api/v1/files/:id: the new
 * title of a document. Trimmed, never empty, at most 200 characters (the
 * same bound a new page's title has).
 */
export const UpdateTitleRequestSchema = z.object({
  title: z.string().trim().min(1).max(200),
});
export type UpdateTitleRequest = z.input<typeof UpdateTitleRequestSchema>;

/**
 * A page's emoji identity: exactly one grapheme after segmentation, at most
 * 16 UTF-16 units. The picker offers a curated set, but the API accepts any
 * single emoji so an older page is never lost. Null clears it.
 */
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
export const IconSchema = z
  .string()
  .max(16)
  .refine(
    (s) => [...graphemeSegmenter.segment(s)].length === 1 && /\p{Extended_Pictographic}/u.test(s),
    'a single emoji'
  );
export type Icon = z.infer<typeof IconSchema>;

/**
 * Body of PATCH /api/v1/pages/:id: a new title, a new icon (null clears) or
 * both; at least one field is required. The title follows the same bound as
 * creation. A title change also updates the live collab document.
 */
export const UpdatePageRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    icon: IconSchema.nullable().optional(),
  })
  .refine((v) => v.title !== undefined || v.icon !== undefined, 'title or icon is required');
export type UpdatePageRequest = z.input<typeof UpdatePageRequestSchema>;


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
  icon: z.string().nullable(),
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
  icon: z.string().nullable(),
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
  icon: z.string().nullable(),
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
  /** The page's own collection, when it is one, and the collection it is a row of. */
  collection: CollectionSchema.nullable(),
  rowOf: CollectionSchema.nullable(),
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
export const SuggestionSummarySchema = z.object({
  id: z.string().uuid(),
  documentId: z.string().uuid(),
  kind: z.enum(['remove', 'replace', 'insert']),
  blockId: z.string().nullable(),
  afterBlockId: z.string().nullable(),
  proposedMarkdown: z.string().nullable(),
  reason: z.string(),
  blockedBy: z.enum(['removal', 'protection', 'conflict', 'no_edit_access']),
  /** What a conflicting citation's source is called, when `blockedBy` is `conflict`. */
  conflictWith: z.string().nullable(),
  status: z.enum(['open', 'accepted', 'declined', 'stale']),
  captureId: z.string().uuid().nullable(),
  createdAt: z.string(),
});
export type SuggestionSummary = z.infer<typeof SuggestionSummarySchema>;
export const SuggestionListSchema = z.array(SuggestionSummarySchema);

export const ReviewItemSchema = z.object({
  version: VersionSummarySchema.extend({
    /** The creator's display name (System for a connector, Former member for someone who left). */
    createdByName: z.string(),
  }),
  document: z.object({
    id: z.string().uuid(),
    title: z.string(),
    icon: z.string().nullable(),
    kind: z.enum(['page', 'file']),
    spaceId: z.string().uuid(),
    spaceName: z.string(),
  }),
  /** What was uploaded, for a file; null for a page. */
  file: z
    .object({ fileName: z.string(), mimeType: z.string(), sizeBytes: z.number().int().nonnegative() })
    .nullable(),
  contributors: z.array(VersionContributorSchema),
  canApprove: z.boolean(),
  /** The capture this snapshot's routed changes came from, if any. */
  capture: z
    .object({
      id: z.string().uuid(),
      senderName: z.string(),
      /** The capture's facts that landed where the reviewer can read, up to 280 characters. */
      excerpt: z.string(),
      /** Other pages the capture changed that the reviewer can read. */
      alsoApplied: z.array(z.object({ pageId: z.string().uuid(), title: z.string() })),
    })
    .nullable(),
  /** The page's open suggestions. */
  suggestions: z.array(SuggestionSummarySchema),
});
export type ReviewItem = z.infer<typeof ReviewItemSchema>;

/** Reply of GET /api/v1/reviews (oldest version first). */
export const ReviewListSchema = z.array(ReviewItemSchema);

/** Query of GET /api/v1/updates: how many recent changes to return (default 8, at most 30). */
export const UpdatesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(30).default(8),
});
export type UpdatesQuery = z.infer<typeof UpdatesQuerySchema>;

/**
 * One entry of the workspace updates feed: a version of a page (newest
 * first) with its page and space and who made it. `actor.type` is `system` for
 * a connector's version (`id` null, name "System"); a user who left the
 * workspace shows as "Former member". No markdown, blocks or Yjs bytes.
 */
export const UpdateItemSchema = z.object({
  versionId: z.string().uuid(),
  number: z.number().int(),
  status: z.enum(['pending_review', 'indexed', 'rejected', 'withdrawn', 'failed']),
  reason: VersionReasonSchema,
  createdAt: z.string().datetime(),
  document: z.object({
    id: z.string().uuid(),
    title: z.string(),
    kind: z.enum(['page', 'file']),
    spaceId: z.string().uuid(),
    spaceName: z.string(),
  }),
  actor: z.object({
    type: z.enum(['user', 'agent', 'system']),
    id: z.string().uuid().nullable(),
    name: z.string(),
  }),
});
export type UpdateItem = z.infer<typeof UpdateItemSchema>;

/** Reply of GET /api/v1/updates. */
export const UpdatesResponseSchema = z.array(UpdateItemSchema);

/**
 * A page the caller last changed or a file the caller uploaded, for Home's
 * Continue cards. `at` is the last block change or the upload time.
 */
export const RecentItemSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(['page', 'file']),
  title: z.string(),
  icon: z.string().nullable(),
  spaceId: z.string().uuid(),
  spaceName: z.string(),
  at: z.string().datetime(),
});
export type RecentItem = z.infer<typeof RecentItemSchema>;

/** Reply of GET /api/v1/recent. */
export const RecentResponseSchema = z.array(RecentItemSchema);
export type RecentResponse = z.infer<typeof RecentResponseSchema>;

export const RecentQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(10).default(3),
});

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
 * (`block_activity`), set for `added` and `changed` only. `author.name` is the
 * author's display name, filled by GET /pages/:id/changes alone (`Former
 * member` / `Agent` when unknown to the tenant); /compare and the version diff
 * send none.
 */
export const BlockDiffEntrySchema = z.object({
  blockId: z.string(),
  change: z.enum(['added', 'removed', 'changed', 'unchanged']),
  /** The block type of the side the entry describes (after; before for removed). */
  type: z.string(),
  /** Heading level, headings only. */
  level: z.number().int().optional(),
  /** Nesting depth, 0 at the top. */
  depth: z.number().int().nonnegative().optional(),
  before: z.string().optional(),
  after: z.string().optional(),
  author: z
    .object({ type: z.enum(['user', 'agent']), id: z.string(), name: z.string().optional() })
    .optional(),
});
export type BlockDiffEntry = z.infer<typeof BlockDiffEntrySchema>;

/** Reply of GET /api/v1/pages/:id/versions (newest first). */
/** A version in the page's history: the summary plus its author's display name (a member's name, an agent's name, "System" for a connector, "Former member" for someone who left). */
export const VersionListItemSchema = VersionSummarySchema.extend({ createdByName: z.string() });
export type VersionListItem = z.infer<typeof VersionListItemSchema>;
export const VersionListSchema = z.array(VersionListItemSchema);

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
 * The status dot a page shows in the tree, computed by the server (the
 * browser computes no status): `failed` (indexing failed), `review` (awaiting
 * approval), `editing` (live text changed in the last minute), else null.
 */
export const AttentionSchema = z.enum(['failed', 'review', 'editing']).nullable();
export type Attention = z.infer<typeof AttentionSchema>;

/**
 * One document in a space's tree (or archived list), as
 * GET /api/v1/spaces/:id/tree and /archived list them. `slug` is null for a
 * document that is not a page (files). `attention` is null in the archived
 * list; a file's dot is `failed` or `review`, never `editing`.
 */
export const TreeNodeSchema = z.object({
  id: z.string().uuid(),
  parentId: z.string().uuid().nullable(),
  position: z.string(),
  kind: z.enum(['page', 'file']),
  title: z.string(),
  icon: z.string().nullable(),
  slug: z.string().nullable(),
  attention: AttentionSchema,
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
  spaceId: z.string().uuid(),
  icon: z.string().nullable(),
  text: z.string(),
  headingPath: z.array(z.string()),
  blockIds: z.array(z.string()),
  /** Whether the passage is from a page or an uploaded file; for a file, the pages (or sheets or slides) it spans. */
  documentKind: z.enum(['page', 'file']),
  pageFrom: z.number().int().nullable(),
  pageTo: z.number().int().nullable(),
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
  documentKind: z.enum(['page', 'file']),
  documentTitle: z.string(),
  spaceId: z.string().uuid(),
  pageFrom: z.number().int().nullable(),
  pageTo: z.number().int().nullable(),
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
    /** When given, the page's whole `fields` map becomes these values (a restore brings back a version's fields). */
    fields: z.record(z.string().uuid(), z.unknown()).optional(),
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

/**
 * Body of POST /internal/set-title: renames a live page. Only the title
 * changes; the blocks are untouched. The actor is the person (or agent) the
 * change is attributed to.
 */
export const CollabSetTitleRequestSchema = z.object({
  documentName: z.string().min(1).max(200),
  title: z.string().trim().min(1).max(200),
  actor: z.object({
    type: z.enum(['user', 'agent']),
    id: z.string().uuid(),
  }),
});
export type CollabSetTitleRequest = z.infer<typeof CollabSetTitleRequestSchema>;

const BlocksSchema = z.array(z.record(z.unknown())).min(1).max(1_000);

/**
 * Body of POST /internal/set-fields: sets field values of a live page in one
 * attributed change; null removes a value. Values are not checked here (the
 * caller checked them against the collection's fields).
 */
export const CollabSetFieldsRequestSchema = z
  .object({
    documentName: z.string().min(1).max(200),
    actor: z.object({ type: z.enum(['user', 'agent']), id: z.string().uuid() }),
    source: z.enum(['agent', 'human']),
    values: z
      .record(z.string().uuid(), z.unknown())
      .refine((v) => Object.keys(v).length > 0 && Object.keys(v).length <= 100, 'Between 1 and 100 values.'),
  })
  .superRefine((req, ctx) => {
    const expected = req.source === 'agent' ? 'agent' : 'user';
    if (req.actor.type !== expected) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['actor', 'type'], message: `A ${req.source} change must be made by a${expected === 'agent' ? 'n agent' : ' user'}.` });
    }
  });
export type CollabSetFieldsRequest = z.infer<typeof CollabSetFieldsRequestSchema>;

/**
 * Body of POST /internal/apply-block-ops: changes single top-level blocks of a
 * live page, all in one attributed change. `agent` changes are made by an
 * agent, `human` ones by a user (an undo is the person's own edit).
 */
export const CollabApplyBlockOpsRequestSchema = z
  .object({
    documentName: z.string().min(1).max(200),
    actor: z.object({
      type: z.enum(['user', 'agent']),
      id: z.string().uuid(),
    }),
    source: z.enum(['agent', 'human']),
    ops: z
      .array(
        z.discriminatedUnion('op', [
          z.object({ op: z.literal('insert_after'), after: z.string().min(1).max(100).nullable(), blocks: BlocksSchema }),
          z.object({
            op: z.literal('replace'),
            blockId: z.string().min(1).max(100),
            blocks: BlocksSchema,
            expectedText: z.string().max(100_000).optional(),
          }),
          z.object({
            op: z.literal('remove'),
            blockId: z.string().min(1).max(100),
            expectedText: z.string().max(100_000).optional(),
          }),
        ])
      )
      .min(1)
      .max(200),
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
export type CollabApplyBlockOpsRequest = z.infer<typeof CollabApplyBlockOpsRequestSchema>;

// ---------------------------------------------------------------------------
// Files (Slice 2)
// ---------------------------------------------------------------------------

/** What a file is, decided by the server from its bytes. SVG and HTML are not types: they are refused. */
export const FILE_TYPES = [
  'pdf',
  'docx',
  'pptx',
  'xlsx',
  'csv',
  'txt',
  'md',
  'png',
  'jpeg',
  'webp',
  'gif',
  'audio',
  'video',
] as const;
export const FileTypeSchema = z.enum(FILE_TYPES);
export type FileType = z.infer<typeof FileTypeSchema>;

/** One run of extracted text: a section of prose or a whole table, with where it sits (page, sheet or slide). */
export const ExtractedSectionSchema = z.object({
  headingPath: z.array(z.string()),
  pageFrom: z.number().int().positive().nullable(),
  pageTo: z.number().int().positive().nullable(),
  kind: z.enum(['text', 'table']),
  text: z.string(),
});
export type ExtractedSection = z.infer<typeof ExtractedSectionSchema>;

/** The extractor's answer, stored beside the file as `extracted.json`. Shared with the Python service. */
export const ExtractedDocumentSchema = z.object({
  pageCount: z.number().int().nonnegative().nullable(),
  sections: z.array(ExtractedSectionSchema),
  ocrUsed: z.boolean(),
});
export type ExtractedDocument = z.infer<typeof ExtractedDocumentSchema>;

/** The text fields of the multipart upload (the file itself is the one file part). */
export const UploadFileFieldsSchema = z.object({
  space_id: z.string().uuid().optional(),
  parent_id: z.string().uuid().optional(),
});
export type UploadFileFields = z.infer<typeof UploadFileFieldsSchema>;

/** A version of a file: the 12 summary keys plus what was uploaded and whether it has searchable text (read, and not set aside as `stored`). */
export const FileVersionSchema = VersionSummarySchema.extend({
  fileName: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  hasText: z.boolean(),
});
export type FileVersion = z.infer<typeof FileVersionSchema>;

/** Reply of GET /api/v1/files/:id/versions (newest first), each with who made it. */
export const FileVersionListSchema = z.array(FileVersionSchema.extend({ createdByName: z.string() }));
export type FileVersionList = z.infer<typeof FileVersionListSchema>;

/** Reply of GET /api/v1/files/:id: the file, its server-computed badge and its latest and indexed versions. */
export const FileDetailsSchema = z.object({
  id: z.string().uuid(),
  spaceId: z.string().uuid(),
  parentId: z.string().uuid().nullable(),
  title: z.string(),
  archivedAt: z.string().datetime().nullable(),
  placement: z.enum(['pinned', 'synced']),
  sourceDeletedAt: z.string().datetime().nullable(),
  badge: z.string(),
  latestVersion: FileVersionSchema.nullable(),
  indexedVersion: FileVersionSchema.nullable(),
});
export type FileDetails = z.infer<typeof FileDetailsSchema>;

/** Reply of POST /api/v1/files and POST /api/v1/files/:id/versions. `unchanged`: the same bytes were already there. */
export const UploadFileResponseSchema = z.object({
  document: DocumentSummarySchema,
  version: FileVersionSchema,
  unchanged: z.boolean(),
});
export type UploadFileResponse = z.infer<typeof UploadFileResponseSchema>;

/** Body of POST /api/v1/files/:id/move: the same as moving a page. */
export const MoveFileRequestSchema = MovePageRequestSchema;
export type MoveFileRequest = z.input<typeof MoveFileRequestSchema>;

/**
 * Reply of GET /api/v1/versions/:id/chunks: the extracted text and the chunks
 * as they are (or would be) indexed. `ready` is false while the text is still
 * being read; `indexed` is true when this is the document's searchable version.
 */
export const ChunkInspectorSchema = z.object({
  versionId: z.string().uuid(),
  indexed: z.boolean(),
  ready: z.boolean(),
  pageCount: z.number().int().nonnegative().nullable(),
  ocrUsed: z.boolean(),
  sections: z.array(ExtractedSectionSchema),
  chunks: z.array(
    z.object({
      ordinal: z.number().int().nonnegative(),
      headingPath: z.array(z.string()),
      pageFrom: z.number().int().nullable(),
      pageTo: z.number().int().nullable(),
      text: z.string(),
      tokenCount: z.number().int().nonnegative(),
    })
  ),
});
export type ChunkInspector = z.infer<typeof ChunkInspectorSchema>;

// --- Sources (upload API) ---------------------------------------------------

/** The id a script gives a file: 1 to 256 characters, no control characters. */
export const ExternalIdSchema = z
  .string()
  .min(1)
  .max(256)
  // eslint-disable-next-line no-control-regex
  .refine((v) => !/[\u0000-\u001f\u007f]/.test(v), 'must not contain control characters');

const SourceNameSchema = z.string().trim().min(1).max(80);

export const CreateSourceRequestSchema = z.object({
  name: SourceNameSchema,
  target_space_id: z.string().uuid(),
});
export type CreateSourceRequest = z.input<typeof CreateSourceRequestSchema>;

export const UpdateSourceRequestSchema = z
  .object({
    name: SourceNameSchema.optional(),
    target_space_id: z.string().uuid().optional(),
    trusted: z.boolean().optional(),
    status: z.enum(['active', 'paused']).optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), 'nothing to change');
export type UpdateSourceRequest = z.input<typeof UpdateSourceRequestSchema>;

export const CreateSourceTokenRequestSchema = z.object({
  name: SourceNameSchema,
  expires_in_days: z.number().int().min(1).max(3650).optional(),
});
export type CreateSourceTokenRequest = z.input<typeof CreateSourceTokenRequestSchema>;

/** A token as listed: never its secret or hash, only the first characters of the secret. */
export const SourceTokenSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  prefix: z.string(),
  createdAt: z.string().datetime(),
  lastUsedAt: z.string().datetime().nullable(),
  expiresAt: z.string().datetime().nullable(),
  revokedAt: z.string().datetime().nullable(),
});
export type SourceToken = z.infer<typeof SourceTokenSchema>;

export const SourceSchema = z.object({
  id: z.string().uuid(),
  kind: z.literal('upload_api'),
  name: z.string(),
  targetSpaceId: z.string().uuid(),
  targetSpaceName: z.string(),
  trusted: z.boolean(),
  status: z.enum(['active', 'paused']),
  itemCount: z.number().int().nonnegative(),
  lastSyncAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  tokens: z.array(SourceTokenSchema),
});
export type Source = z.infer<typeof SourceSchema>;
export const SourceListSchema = z.array(SourceSchema);

/** Reply of POST /api/v1/sources/:id/tokens: the only time the secret is shown. */
export const CreateSourceTokenResponseSchema = z.object({
  token: z.string(),
  info: SourceTokenSchema,
});
export type CreateSourceTokenResponse = z.infer<typeof CreateSourceTokenResponseSchema>;

/** Reply of PUT /api/v1/source/files/:externalId. `created`: a new document (not just a new version). */
export const SourcePutResponseSchema = UploadFileResponseSchema.extend({ created: z.boolean() });
export type SourcePutResponse = z.infer<typeof SourcePutResponseSchema>;

/** Reply of DELETE /api/v1/source/files/:externalId. */
export const SourceDeleteResponseSchema = z.object({ removed: z.literal(true) });
export type SourceDeleteResponse = z.infer<typeof SourceDeleteResponseSchema>;

/**
 * Reply of GET /api/v1/versions/:id/text: the text read from a file version, section by section,
 * without chunks (so a viewer can see what an editor sees, minus how it is cut for search).
 * `pageCount` is null while the text has not been read.
 */
export const VersionTextSchema = z.object({
  versionId: z.string().uuid(),
  pageCount: z.number().int().nonnegative().nullable(),
  ocrUsed: z.boolean(),
  sections: z.array(ExtractedSectionSchema),
});
export type VersionText = z.infer<typeof VersionTextSchema>;

// ---------------------------------------------------------------------------
// Routing engine: captures, receipts and suggestions
// ---------------------------------------------------------------------------

/** Longest capture text accepted (`capture_too_long` above it). */
export const MAX_CAPTURE_CHARS = 20_000;

export const CreateCaptureRequestSchema = z
  .object({
    /** What was typed; may be empty when a file is sent. */
    text: z.string().trim().default(''),
    /** A file in the sender's Inbox (uploaded first): its text is read and routed after the typed text. */
    file_id: z.string().uuid().optional(),
    scope_space_id: z.string().uuid().optional(),
    scope_page_id: z.string().uuid().optional(),
    /** auto: the engine decides (a file is a document); document: always also a new page; updates: never a new page. */
    shape: z.enum(['auto', 'document', 'updates']).default('auto'),
  })
  .refine((c) => c.text !== '' || c.file_id !== undefined, { message: 'Write something or attach a file.' });

export const CaptureSummarySchema = z.object({
  id: z.string().uuid(),
  senderType: z.enum(['user', 'agent']),
  senderId: z.string().uuid(),
  /** The sender's display name (Former member for someone who left). */
  senderName: z.string(),
  channel: z.enum(['console', 'mcp']),
  text: z.string(),
  scopeSpaceId: z.string().uuid().nullable(),
  scopePageId: z.string().uuid().nullable(),
  status: z.enum(['queued', 'routing', 'waiting_for_answer', 'done', 'failed']),
  error: z.string().nullable(),
  shapeMode: z.enum(['auto', 'document', 'updates']),
  /** Null until the capture is split. */
  shape: z.enum(['document', 'updates']).nullable(),
  /** The file sent with it; null for typed text only, or when the file is gone. */
  file: z.object({ id: z.string().uuid(), name: z.string(), mimeType: z.string().nullable() }).nullable(),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
});
export type CaptureSummary = z.infer<typeof CaptureSummarySchema>;
export const CaptureListSchema = z.array(CaptureSummarySchema);

export const CaptureListQuerySchema = z.object({ before: z.string().datetime().optional() });

export const CaptureMessageSchema = z.object({
  id: z.string().uuid(),
  author: z.enum(['engine', 'sender']),
  body: z.string(),
  options: z.array(z.object({ entityId: z.string().uuid(), label: z.string() })).nullable(),
  answersMessageId: z.string().uuid().nullable(),
  choice: z.string().nullable(),
  createdAt: z.string(),
});


export const CaptureChangeSchema = z.object({
  id: z.string().uuid(),
  /** Null for the blocks of a document capture's own page. */
  factId: z.string().uuid().nullable(),
  documentId: z.string().uuid(),
  op: z.enum(['insert', 'replace', 'create_page']),
  blockId: z.string(),
  beforeMarkdown: z.string().nullable(),
  afterMarkdown: z.string(),
  status: z.enum(['applied', 'undone', 'moved']),
  reason: z.string().nullable(),
});
export type CaptureChange = z.infer<typeof CaptureChangeSchema>;
export const CaptureChangeListSchema = z.array(CaptureChangeSchema);

export const CaptureReceiptSchema = z.object({
  spaces: z.array(
    z.object({
      spaceId: z.string().uuid(),
      spaceName: z.string(),
      pages: z.array(
        z.object({
          documentId: z.string().uuid(),
          title: z.string(),
          /** applied: indexed or indexing; waiting_review: its snapshot waits; suggestion: only suggestions. */
          outcome: z.enum(['applied', 'waiting_review', 'suggestion']),
          changes: z.array(CaptureChangeSchema),
          suggestions: z.array(SuggestionSummarySchema),
        })
      ),
    })
  ),
  /** Changes on pages in spaces the viewer cannot read: counted, never shown. */
  hiddenChanges: z.number().int().nonnegative(),
  alreadyKnown: z.array(z.object({ factId: z.string().uuid(), statement: z.string() })),
  needsHome: z.array(z.object({ factId: z.string().uuid(), statement: z.string(), reason: z.string().nullable() })),
  /** The page a document capture became (or is waiting to become); null for updates or a page the viewer cannot read. */
  document: z
    .object({
      pageId: z.string().uuid().nullable(),
      title: z.string(),
      outcome: z.enum(['pending', 'needs_home', 'created']),
      parentTitle: z.string().nullable(),
      spaceName: z.string().nullable(),
      reason: z.string().nullable(),
      /** The page's own changes (Undo archives the page). */
      changeIds: z.array(z.string().uuid()),
    })
    .nullable(),
  /** Facts kept only on the document's page. */
  filedInDocument: z.array(z.object({ factId: z.string().uuid(), statement: z.string() })),
});
export type CaptureReceipt = z.infer<typeof CaptureReceiptSchema>;

export const CaptureDetailSchema = z.object({
  capture: CaptureSummarySchema,
  thread: z.array(CaptureMessageSchema),
  receipt: CaptureReceiptSchema,
});
export type CaptureDetail = z.infer<typeof CaptureDetailSchema>;

export const AnswerCaptureRequestSchema = z.object({
  message_id: z.string().uuid(),
  choice: z.string().uuid(),
});

export const UndoChangesResponseSchema = z.object({
  undone: z.array(z.string().uuid()),
  /** Changes whose block a person changed since: left alone. */
  changedSince: z.array(z.string().uuid()),
});
export type UndoChangesResponse = z.infer<typeof UndoChangesResponseSchema>;

export const MoveChangeRequestSchema = z.object({ target_page_id: z.string().uuid() });
export const MoveChangeResponseSchema = z.object({ moved: z.string().uuid(), factId: z.string().uuid() });

export const PlaceFactRequestSchema = z.object({ document_id: z.string().uuid() });

export const NeedsHomeItemSchema = z.object({
  factId: z.string().uuid(),
  captureId: z.string().uuid(),
  statement: z.string(),
  reason: z.string().nullable(),
  createdAt: z.string(),
});
export type NeedsHomeItem = z.infer<typeof NeedsHomeItemSchema>;
export const NeedsHomeListSchema = z.array(NeedsHomeItemSchema);

/** A document capture waiting for a person to choose where its page goes. */
export const NeedsHomeDocumentSchema = z.object({
  captureId: z.string().uuid(),
  title: z.string(),
  subject: z.string().nullable(),
  reason: z.string().nullable(),
  options: z.array(z.object({ pageId: z.string().uuid(), title: z.string(), spaceId: z.string().uuid(), spaceName: z.string() })),
  createdAt: z.string(),
});
export type NeedsHomeDocument = z.infer<typeof NeedsHomeDocumentSchema>;
export const NeedsHomeDocumentListSchema = z.array(NeedsHomeDocumentSchema);

/** Where a waiting document's page goes: under a page, or at the top of a space. */
export const PlaceDocumentRequestSchema = z
  .object({
    parent_page_id: z.string().uuid().optional(),
    space_id: z.string().uuid().optional(),
    title: z.string().trim().min(1).max(200).optional(),
  })
  .refine((b) => (b.parent_page_id === undefined) !== (b.space_id === undefined), {
    message: 'Give a parent page or a space, not both.',
  });

export const MoveDocumentRequestSchema = z.object({ parent_page_id: z.string().uuid() });
export const FactStatusSchema = z.object({
  factId: z.string().uuid(),
  outcome: z.enum([
    'pending',
    'applied',
    'waiting_review',
    'suggested',
    'needs_home',
    'already_known',
    'dismissed',
    'undone',
    'filed_in_document',
  ]),
});

/** GET /api/v1/link-targets: pages for the `[[` picker, best title match first (recent pages when `q` is empty). */
export const LinkTargetQuerySchema = z.object({
  q: z.string().max(200).default(''),
  limit: z.coerce.number().int().min(1).max(20).default(8),
});
export const LinkTargetSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  icon: z.string().nullable(),
  spaceId: z.string().uuid(),
  spaceName: z.string(),
  /** The parent page's title, to tell same-named pages apart. */
  parentTitle: z.string().nullable(),
});
export type LinkTarget = z.infer<typeof LinkTargetSchema>;
export const LinkTargetListSchema = z.array(LinkTargetSchema);

/** GET /api/v1/documents/titles?ids=a,b: the current titles of link targets the caller can read. */
export const DocumentTitlesQuerySchema = z.object({
  ids: z
    .string()
    .transform((s) => [...new Set(s.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean))])
    .pipe(z.array(z.string().uuid()).min(1).max(100)),
});
export const DocumentTitleSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(['page', 'file']),
  title: z.string(),
  icon: z.string().nullable(),
});
export type DocumentTitle = z.infer<typeof DocumentTitleSchema>;
/** Only readable, live documents are listed: a missing id shows as "Page unavailable". */
export const DocumentTitleListSchema = z.array(DocumentTitleSchema);

const ConnectedPageSchema = z.object({
  pageId: z.string().uuid(),
  title: z.string(),
  icon: z.string().nullable(),
  spaceName: z.string(),
});

/** GET /api/v1/pages/:id/connections: how the page connects to others, readable pages only. */
export const PageConnectionsSchema = z.object({
  /** Pages whose blocks link here (from their latest snapshot). */
  linkedFrom: z.array(ConnectedPageSchema.extend({ blockId: z.string(), excerpt: z.string() })),
  /** Document pages whose facts the routing engine wrote onto this page. */
  updatedBy: z.array(ConnectedPageSchema.extend({ blockIds: z.array(z.string()) })),
  /** For a document page: the standing pages its facts updated, with how many sections changed. */
  updated: z.array(ConnectedPageSchema.extend({ captureId: z.string().uuid(), sections: z.number().int() })),
});
export type PageConnections = z.infer<typeof PageConnectionsSchema>;

/** A comment's body: the comment editor's blocks (BlockNote JSON). Its text is at most 5,000 characters. */
export const CommentBodySchema = z.array(z.record(z.unknown())).min(1).max(100);

export const CommentSchema = z.object({
  id: z.string().uuid(),
  authorId: z.string().uuid(),
  /** The author's display name (Former member for someone who left). */
  authorName: z.string(),
  /** Null once deleted: the comment keeps its place in the thread. */
  body: CommentBodySchema.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  deletedAt: z.string().nullable(),
});
export type Comment = z.infer<typeof CommentSchema>;

export const CommentThreadSchema = z.object({
  id: z.string().uuid(),
  documentId: z.string().uuid(),
  /** The block the thread was started on, and its text: where it was if the comment mark is gone. */
  blockId: z.string().nullable(),
  quote: z.string().nullable(),
  createdBy: z.string().uuid(),
  createdAt: z.string(),
  updatedAt: z.string(),
  resolved: z.boolean(),
  resolvedBy: z.string().uuid().nullable(),
  resolvedAt: z.string().nullable(),
  comments: z.array(CommentSchema),
});
export type CommentThread = z.infer<typeof CommentThreadSchema>;
export const CommentThreadListSchema = z.array(CommentThreadSchema);

export const CreateThreadRequestSchema = z.object({
  block_id: z.string().max(100).nullable().default(null),
  quote: z
    .string()
    .nullable()
    .default(null)
    .transform((q) => (q === null ? null : q.replace(/\s+/g, ' ').trim().slice(0, 200) || null)),
  body: CommentBodySchema,
});
export const CommentRequestSchema = z.object({ body: CommentBodySchema });

/** GET /api/v1/mentionable: people to mention on a page, best name match first. */
export const MentionableQuerySchema = z.object({
  page_id: z.string().uuid(),
  q: z.string().max(100).default(''),
  limit: z.coerce.number().int().min(1).max(20).default(8),
});
export const MentionableSchema = z.object({
  userId: z.string().uuid(),
  name: z.string(),
  /** False when they can't read the page: they would not be told. */
  canRead: z.boolean(),
});
export type Mentionable = z.infer<typeof MentionableSchema>;
export const MentionableListSchema = z.array(MentionableSchema);

export const NotificationKindSchema = z.enum([
  'mention',
  'comment_reply',
  'review_requested',
  'review_approved',
  'review_rejected',
  'capture_waiting',
]);
export const NotificationSchema = z.object({
  id: z.string().uuid(),
  kind: NotificationKindSchema,
  actorName: z.string(),
  documentId: z.string().uuid().nullable(),
  documentKind: z.enum(['page', 'file']).nullable(),
  documentTitle: z.string().nullable(),
  blockId: z.string().nullable(),
  threadId: z.string().uuid().nullable(),
  captureId: z.string().uuid().nullable(),
  excerpt: z.string().nullable(),
  createdAt: z.string(),
  readAt: z.string().nullable(),
});
export type Notification = z.infer<typeof NotificationSchema>;
/** The newest 50 the reader may still see, and how many of all those are unread. */
export const NotificationListSchema = z.object({ unread: z.number().int(), items: z.array(NotificationSchema) });
export type NotificationList = z.infer<typeof NotificationListSchema>;
/** Marks the given notifications read, or all of them when `ids` is left out. */
export const MarkNotificationsReadRequestSchema = z.object({ ids: z.array(z.string().uuid()).max(200).optional() });
