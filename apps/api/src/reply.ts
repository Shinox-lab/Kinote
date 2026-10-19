import type { ZodType, ZodTypeDef } from 'zod';

/**
 * Checks a reply against its contract schema before it is sent. A mismatch is
 * a server bug: it throws a plain Error (so the error handler logs it and
 * answers 500 `internal_error`, never a 4xx and never the reply) whose message
 * names the schema issue paths and codes but none of the reply's values.
 */
export function parseReply<T>(schema: ZodType<T, ZodTypeDef, unknown>, data: unknown): T {
  const parsed = schema.safeParse(data);
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.code}`)
    .join('; ');
  throw new Error(`Reply does not match its contract (${issues})`);
}
