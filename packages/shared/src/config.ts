import { z } from 'zod';

/** Per-IP sign-up and sign-in attempts per minute when `AUTH_RATE_LIMIT_MAX` is unset. */
export const DEFAULT_AUTH_RATE_LIMIT_MAX = 10;

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
  /**
   * Bind address of the api and collab servers. Loopback by default, so a
   * service run on the host is not reachable from the network by accident;
   * docker-compose.yml sets 0.0.0.0 (inside the container) explicitly.
   */
  HOST: z.string().min(1).default('127.0.0.1'),
  /**
   * Whether the api trusts X-Forwarded-For (the client IP the auth rate limit
   * keys on). `false` (default): no proxy in front, the header is ignored.
   * A positive hop count N (recommended behind a proxy): the address N hops
   * from the right of the header is the client; anything a client put to the
   * left of it is ignored. `true` trusts every hop, so a client-supplied
   * X-Forwarded-For picks its own rate-limit bucket. See docs/operations.md.
   */
  TRUST_PROXY: z
    .string()
    .default('false')
    .refine((v) => v === 'true' || v === 'false' || /^[1-9][0-9]{0,2}$/.test(v), {
      message: 'must be true, false or a hop count from 1 to 999',
    })
    .transform((v): boolean | number => (v === 'true' ? true : v === 'false' ? false : Number(v))),
  /**
   * Per-IP sign-up and sign-in attempts per minute (each route counted
   * separately). Capped so a typo (an extra zero, a byte count) cannot turn the
   * brute-force limit into no limit at all.
   */
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().max(100_000).default(DEFAULT_AUTH_RATE_LIMIT_MAX),
  /** pino level of the api's log (stdout). Request headers and bodies are never logged. */
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  EMBEDDING_PROVIDER: z.enum(['deterministic']).default('deterministic'),
  S3_ENDPOINT: z.string().min(1).optional(),
  S3_BUCKET: z.string().min(1).optional(),
  S3_ACCESS_KEY: z.string().min(1).optional(),
  S3_SECRET_KEY: z.string().min(1).optional(),
  S3_REGION: z.string().min(1).default('us-east-1'),
  /** Largest file the api accepts, in bytes (default 50 MB; at most 500 MB). */
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().max(524_288_000).default(52_428_800),
  /** Most text, in characters, one file may yield; more fails the file (never truncated). */
  MAX_EXTRACTED_CHARS: z.coerce.number().int().positive().default(2_000_000),
  /** `off`: only text files can be read; `fake`: tests and local e2e; `http`: the Docling service. */
  EXTRACTOR_MODE: z.enum(['off', 'fake', 'http']).default('off'),
  EXTRACTOR_URL: z.string().min(1).optional(),
  /**
   * How long the worker waits for the extractor. Kept under the worker's job
   * lease (300 s), so a slow file is not claimed and run a second time.
   */
  EXTRACTOR_TIMEOUT_MS: z.coerce.number().int().positive().max(270_000).default(240_000),
}).superRefine((value, ctx) => {
  if (value.EXTRACTOR_MODE === 'http' && !value.EXTRACTOR_URL) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['EXTRACTOR_URL'],
      message: 'is required when EXTRACTOR_MODE is http',
    });
  }
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
