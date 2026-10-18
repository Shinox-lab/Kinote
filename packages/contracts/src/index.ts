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

/** Reply of POST /api/v1/versions/:id/retry (no request body): the summary plus its document. */
export const RetryVersionResponseSchema = VersionSummarySchema.extend({
  documentId: z.string().uuid(),
});
export type RetryVersionResponse = z.infer<typeof RetryVersionResponseSchema>;

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
