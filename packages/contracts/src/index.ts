import { z } from 'zod';

export const ErrorCodeSchema = z.enum([
  'space_not_found',
  'page_not_found',
  'document_not_found',
  'version_not_found',
  'source_not_found',
  'block_not_found',
  'parent_not_found',
  'forbidden',
  'space_name_taken',
  'slug_taken',
  'no_changes',
  'version_not_pending',
  'self_approval',
  'has_children',
  'parent_cycle',
  'page_archived',
  'block_recently_edited',
  'managed_by_source',
  'whatsapp_not_linked',
  'empty_file',
  'file_too_large',
  'unsupported_file_type',
  'quota_exceeded',
  'rate_limited',
  'embedding_unavailable',
  'extractor_unavailable',
  'source_unavailable',
]);

export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const ERROR_SENTENCES: Record<ErrorCode, string> = {
  space_not_found: 'The requested space could not be found.',
  page_not_found: 'The requested page could not be found.',
  document_not_found: 'The requested document could not be found.',
  version_not_found: 'The requested version could not be found.',
  source_not_found: 'The requested source could not be found.',
  block_not_found: 'The target content block could not be found on this page.',
  parent_not_found: 'The selected parent page does not exist in this space.',
  forbidden: 'You do not have permission to perform this action.',
  space_name_taken: 'A space with this name already exists in your organisation.',
  slug_taken: 'That URL slug is already in use inside this space.',
  no_changes: 'There are no new changes to snapshot since the latest version.',
  version_not_pending: 'This version is no longer waiting for review.',
  self_approval: 'You cannot approve your own changes in this space, and agent changes always require a different human reviewer.',
  has_children: 'Move or archive child documents before archiving this page.',
  parent_cycle: 'A page cannot be moved inside itself or one of its descendants.',
  page_archived: 'This page is archived. Restore it before making changes.',
  block_recently_edited: 'A person edited this block recently; please wait or leave a comment instead.',
  managed_by_source: 'This file is managed by an external source and cannot be edited by hand.',
  whatsapp_not_linked: 'Connect a WhatsApp number before performing this action.',
  empty_file: 'The page body or uploaded file cannot be empty.',
  file_too_large: 'This file exceeds your plan size limit.',
  unsupported_file_type: 'This file type is not supported for security reasons.',
  quota_exceeded: 'Your organisation has reached its monthly usage quota; ingestion is paused.',
  rate_limited: 'Too many requests; please wait a moment and try again.',
  embedding_unavailable: 'The embedding service is temporarily unavailable; your job will retry automatically.',
  extractor_unavailable: 'The document extraction service is temporarily unavailable; your job will retry automatically.',
  source_unavailable: 'The external source is temporarily unreachable; sync will retry automatically.',
};

export const ApiErrorSchema = z.object({
  error: ErrorCodeSchema,
  message: z.string(),
});

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
  'agent.created',
  'agent.token_issued',
  'agent.tool_called',
  'space.created',
  'space.settings_changed',
  'space.grant_changed',
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

export const CreateTenantRequestSchema = z.object({
  name: z.string().trim().min(1).max(120),
  slug: z.string().regex(/^[a-z0-9-]+$/).min(1).max(80),
  owner_email: z.string().email(),
  owner_name: z.string().trim().min(1).max(120),
});

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

export const SearchRequestSchema = z.object({
  query: z.string().trim().min(1).max(500),
  space_ids: z.array(z.string().uuid()).optional(),
  limit: z.number().int().min(1).max(50).default(10),
});

export const AskRequestSchema = z.object({
  question: z.string().trim().min(1).max(1000),
  space_ids: z.array(z.string().uuid()).optional(),
});
