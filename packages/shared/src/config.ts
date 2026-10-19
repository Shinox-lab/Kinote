import { z } from 'zod';

/**
 * Environment contract shared by the api, collab and worker services.
 * `DATABASE_URL` is the `living_wiki_app` role (no superuser, no BYPASSRLS);
 * `DATABASE_MIGRATE_URL` is the schema owner, used only by `pnpm db:migrate`.
 */
export const ConfigSchema = z.object({
  DATABASE_URL: z.string().min(1),
  DATABASE_MIGRATE_URL: z.string().min(1).optional(),
  COLLAB_TOKEN_SECRET: z.string().min(32),
  INTERNAL_SECRET: z.string().min(32),
  COLLAB_INTERNAL_URL: z.string().min(1).default('http://127.0.0.1:1234'),
  API_PORT: z.coerce.number().int().min(0).max(65535).default(8787),
  COLLAB_PORT: z.coerce.number().int().min(0).max(65535).default(1234),
  /** Bind address of the api. */
  HOST: z.string().min(1).default('0.0.0.0'),
  /**
   * `true` when the api sits behind a reverse proxy: Fastify then takes the
   * client IP from X-Forwarded-For, so rate limits key on the real client.
   */
  TRUST_PROXY: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  /** Per-IP sign-up and sign-in attempts per minute (each route counted separately). */
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),
  EMBEDDING_PROVIDER: z.enum(['deterministic']).default('deterministic'),
  EMBEDDING_DIMENSIONS: z.coerce.number().int().positive().max(4000).default(1536),
  S3_ENDPOINT: z.string().min(1).optional(),
  S3_BUCKET: z.string().min(1).optional(),
  S3_ACCESS_KEY: z.string().min(1).optional(),
  S3_SECRET_KEY: z.string().min(1).optional(),
  S3_REGION: z.string().min(1).default('us-east-1'),
});

export type Config = z.infer<typeof ConfigSchema>;

/**
 * Parses and validates the environment. Throws one Error naming every
 * missing or invalid variable (never its value, so secrets stay out of logs).
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  // Treat empty strings (e.g. `S3_ENDPOINT=` in a .env file) as unset.
  const cleaned: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    cleaned[key] = value === '' ? undefined : value;
  }
  const result = ConfigSchema.safeParse(cleaned);
  if (result.success) return result.data;

  const problems = result.error.issues.map((issue) => {
    const name = issue.path.join('.') || '(config)';
    const missing = issue.code === 'invalid_type' && issue.received === 'undefined';
    return missing ? `${name} (missing)` : `${name} (${issue.message})`;
  });
  throw new Error(`Invalid environment configuration: ${problems.join('; ')}`);
}
