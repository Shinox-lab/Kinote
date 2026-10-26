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
  'file_unreadable',
  'file_text_too_large',
  'quota_exceeded',
  'rate_limited',
  'embedding_unavailable',
  'search_unavailable',
  'llm_unavailable',
  'router_unavailable',
  'extractor_unavailable',
  'source_unavailable',
  'unauthenticated',
  'invalid_credentials',
  'validation_failed',
  'email_taken',
  'invitation_invalid',
  'tenant_not_found',
  'principal_not_found',
  'space_archived',
  'last_owner',
  'group_name_taken',
  'version_not_failed',
  'not_removed',
  'source_name_taken',
  'internal_error',
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
  file_unreadable: 'This file could not be read. It may be encrypted or damaged.',
  file_text_too_large: 'This file has more text than can be indexed.',
  quota_exceeded: 'Your organisation has reached its monthly usage quota; ingestion is paused.',
  rate_limited: 'Too many requests; please wait a moment and try again.',
  embedding_unavailable: 'The embedding service is temporarily unavailable; your job will retry automatically.',
  search_unavailable: 'Search is temporarily unavailable. Please try again.',
  llm_unavailable: 'The answer service is temporarily unavailable. Please try again.',
  router_unavailable: 'The routing service is temporarily unavailable; it will retry automatically.',
  extractor_unavailable: 'The document extraction service is temporarily unavailable; your job will retry automatically.',
  source_unavailable: 'The external source is temporarily unreachable; sync will retry automatically.',
  unauthenticated: 'Please sign in to continue.',
  invalid_credentials: 'The email or password is incorrect.',
  validation_failed: 'Some of the information you entered is not valid.',
  email_taken: 'An account with this email address already exists.',
  invitation_invalid: 'This invitation is invalid, expired or already used.',
  tenant_not_found: 'The requested organisation could not be found.',
  principal_not_found: 'The requested member or agent could not be found.',
  space_archived: 'This space is archived. Restore it before making changes.',
  last_owner: 'An organisation must keep at least one owner.',
  group_name_taken: 'A group with this name already exists in your organisation.',
  version_not_failed: 'Only a failed version can be retried.',
  not_removed: 'This file has not been removed at its source.',
  source_name_taken: 'A source with this name already exists in your organisation.',
  internal_error: 'Something went wrong.',
};

const NOT_FOUND_CODES = ErrorCodeSchema.options.filter((c) => c.endsWith('_not_found'));

const STATUS_OVERRIDES: Partial<Record<ErrorCode, number>> = {
  invitation_invalid: 404,
  forbidden: 403,
  unauthenticated: 401,
  invalid_credentials: 401,
  validation_failed: 400,
  empty_file: 400,
  file_too_large: 413,
  unsupported_file_type: 415,
  file_unreadable: 422,
  file_text_too_large: 422,
  quota_exceeded: 429,
  rate_limited: 429,
  embedding_unavailable: 503,
  search_unavailable: 503,
  llm_unavailable: 503,
  router_unavailable: 503,
  extractor_unavailable: 503,
  source_unavailable: 503,
  internal_error: 500,
};

/** HTTP status for every error code: *_not_found 404, listed overrides, everything else 409. */
export const ERROR_STATUS = Object.fromEntries(
  ErrorCodeSchema.options.map((code) => [
    code,
    NOT_FOUND_CODES.includes(code) ? 404 : (STATUS_OVERRIDES[code] ?? 409),
  ])
) as Record<ErrorCode, number>;

export class AppError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message?: string) {
    super(message ?? ERROR_SENTENCES[code]);
    this.name = 'AppError';
    this.code = code;
  }

  get statusCode(): number {
    return ERROR_STATUS[this.code];
  }
}

export const ApiErrorSchema = z.object({
  error: ErrorCodeSchema,
  message: z.string(),
  issues: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
});
