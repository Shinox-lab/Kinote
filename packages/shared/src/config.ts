import { z } from 'zod';

/** Per-IP sign-up and sign-in attempts per minute when `AUTH_RATE_LIMIT_MAX` is unset. */
export const DEFAULT_AUTH_RATE_LIMIT_MAX = 10;

/**
 * Environment contract shared by the api, collab and worker services.
 * `DATABASE_URL` is the `kinote_app` role (no superuser, no BYPASSRLS);
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
  EMBEDDING_PROVIDER: z.enum(['deterministic', 'openai']).default('deterministic'),
  EMBEDDING_BASE_URL: z.string().url().optional(),
  EMBEDDING_API_KEY: z.string().min(1).optional(),
  EMBEDDING_MODEL: z.string().min(1).optional(),
  EMBEDDING_BATCH_SIZE: z.coerce.number().int().positive().max(2048).default(64),
  EMBEDDING_TIMEOUT_MS: z.coerce.number().int().positive().max(120_000).default(30_000),
  EMBEDDING_QUERY_INSTRUCTION: z.string().min(1).optional(),
  ASK_PROVIDER: z.enum(['deterministic', 'openai']).default('deterministic'),
  ASK_BASE_URL: z.string().url().optional(),
  ASK_API_KEY: z.string().min(1).optional(),
  ASK_MODEL: z.string().min(1).optional(),
  ASK_TIMEOUT_MS: z.coerce.number().int().positive().max(120_000).default(60_000),
  ASK_MAX_TOKENS: z.coerce.number().int().positive().max(8192).default(800),
  /** The model that writes page cards, extracts entities and routes captures. */
  ROUTER_PROVIDER: z.enum(['deterministic', 'openai']).default('deterministic'),
  ROUTER_BASE_URL: z.string().url().optional(),
  ROUTER_API_KEY: z.string().min(1).optional(),
  ROUTER_MODEL: z.string().min(1).optional(),
  ROUTER_TIMEOUT_MS: z.coerce.number().int().positive().max(120_000).default(60_000),
  ROUTER_MAX_TOKENS: z.coerce.number().int().positive().max(8192).default(2000),
  /** `off`: ask a reasoning model not to think first (OpenRouter); its thinking counts toward ROUTER_MAX_TOKENS. */
  ROUTER_REASONING: z.enum(['off']).optional(),
  S3_ENDPOINT: z.string().min(1).optional(),
  S3_BUCKET: z.string().min(1).optional(),
  S3_ACCESS_KEY: z.string().min(1).optional(),
  S3_SECRET_KEY: z.string().min(1).optional(),
  S3_REGION: z.string().min(1).default('us-east-1'),
  /** `true`/`false`; unset means path-style whenever S3_ENDPOINT is set. */
  S3_FORCE_PATH_STYLE: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
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
  if (value.EMBEDDING_PROVIDER === 'openai') {
    if (!value.EMBEDDING_BASE_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['EMBEDDING_BASE_URL'],
        message: 'is required when EMBEDDING_PROVIDER is openai',
      });
    }
    if (!value.EMBEDDING_MODEL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['EMBEDDING_MODEL'],
        message: 'is required when EMBEDDING_PROVIDER is openai',
      });
    }
  }
  if (value.ROUTER_PROVIDER === 'openai') {
    if (!value.ROUTER_BASE_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ROUTER_BASE_URL'],
        message: 'is required when ROUTER_PROVIDER is openai',
      });
    }
    if (!value.ROUTER_MODEL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ROUTER_MODEL'],
        message: 'is required when ROUTER_PROVIDER is openai',
      });
    }
  }
  if (value.ASK_PROVIDER === 'openai') {
    if (!value.ASK_BASE_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ASK_BASE_URL'],
        message: 'is required when ASK_PROVIDER is openai',
      });
    }
    if (!value.ASK_MODEL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ASK_MODEL'],
        message: 'is required when ASK_PROVIDER is openai',
      });
    }
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

/**
 * Why the worker must not start, or null. The deterministic router is a
 * rule-based stand-in for tests: next to a real embedding or Ask model it means
 * the routing settings were left out, and every capture would be filed by rules.
 */
export function routerProviderProblem(config: Config): string | null {
  if (config.ROUTER_PROVIDER !== 'deterministic') return null;
  if (config.EMBEDDING_PROVIDER === 'deterministic' && config.ASK_PROVIDER === 'deterministic') return null;
  return (
    'ROUTER_PROVIDER is deterministic (the rule-based test stand-in) while real embedding or Ask models are set: ' +
    'set ROUTER_PROVIDER=openai with ROUTER_BASE_URL and ROUTER_MODEL'
  );
}
