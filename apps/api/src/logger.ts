import type { FastifyServerOptions } from 'fastify';

/** How the API logs: pino at `level`, to stdout unless a `stream` is given (tests). */
export interface ApiLoggerOptions {
  level: string;
  stream?: { write(line: string): void };
}

/**
 * Header values that never reach a log line, wherever a request's headers are
 * logged: the session token, cookies and the collab internal secret. Fastify's
 * own request serializer logs no headers at all; this covers anything that
 * logs `req.headers` (or a `headers` object) explicitly.
 */
const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-internal-secret"]',
  'headers.authorization',
  'headers.cookie',
  'headers["x-internal-secret"]',
];

interface SerializedError {
  [key: string]: unknown;
  type: string;
  message: string;
  stack: string;
  code?: unknown;
  cause?: SerializedError;
}

/**
 * Errors as logged: type, message, stack, code and cause, nothing else (no
 * enumerable extras such as a pg error's `detail`, which quotes row values).
 * A Drizzle query error keeps its SQL but loses its params line: the params
 * are row values (emails, token hashes) and do not belong in a log.
 */
export function serializeError(err: unknown, depth = 0): SerializedError {
  if (!(err instanceof Error)) {
    return { type: typeof err, message: String(err), stack: '' };
  }
  let message = err.message;
  let stack = err.stack ?? '';
  const query = (err as { query?: unknown }).query;
  if (typeof query === 'string' && 'params' in err) {
    message = `Failed query: ${query}`;
    stack = stack.replace(err.message, message);
  }
  const out: SerializedError = { type: err.name, message, stack };
  const code = (err as { code?: unknown }).code;
  if (code !== undefined) out.code = code;
  if (err.cause !== undefined && depth < 3) out.cause = serializeError(err.cause, depth + 1);
  return out;
}

/** Fastify's `logger` option for `opts` (false, i.e. silent, without options). */
export function fastifyLogger(opts: ApiLoggerOptions | undefined): FastifyServerOptions['logger'] {
  if (!opts) return false;
  return {
    level: opts.level,
    ...(opts.stream ? { stream: opts.stream } : {}),
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    serializers: { err: (err: Error) => serializeError(err) },
  };
}
