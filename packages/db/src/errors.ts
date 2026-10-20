import { AppError, type ErrorCode } from '@living-wiki/contracts';

const UNIQUE_VIOLATION = '23505';

const UNIQUE_CONSTRAINT_CODES: Record<string, ErrorCode> = {
  tenants_slug_unique: 'slug_taken',
  spaces_tenant_name_idx: 'space_name_taken',
  spaces_tenant_slug_idx: 'slug_taken',
  pages_space_slug_idx: 'slug_taken',
  groups_tenant_name_idx: 'group_name_taken',
  sources_tenant_name_idx: 'source_name_taken',
  users_email_unique: 'email_taken',
};

/**
 * Maps a Postgres unique-violation (SQLSTATE 23505) to the contract error for
 * the violated constraint. Drizzle wraps driver errors, so both the error and
 * its `cause` chain are inspected. Returns null for anything else (the caller
 * answers 500 without leaking the cause).
 */
export function mapDbError(err: unknown): AppError | null {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth++) {
    const { code, constraint, cause } = current as {
      code?: unknown;
      constraint?: unknown;
      cause?: unknown;
    };
    if (code === UNIQUE_VIOLATION && typeof constraint === 'string') {
      const mapped = UNIQUE_CONSTRAINT_CODES[constraint];
      return mapped ? new AppError(mapped) : null;
    }
    current = cause;
  }
  return null;
}
