import type { FastifyRateLimitStore } from '@fastify/rate-limit';
import { hitCounter } from '@kinote/db';

/**
 * `@fastify/rate-limit` store on the shared Postgres counters
 * (`rate_limit_counters`), so every api process counts against the same
 * limits. Each route gets its own key prefix (method and path), as the
 * plugin's in-memory store keeps one map per route.
 *
 * A database error is handed to the plugin: routes with `skipOnError: true`
 * let the request through, the others (sign-in, sign-up) answer 500.
 */
export class PgRateLimitStore implements FastifyRateLimitStore {
  /** The plugin constructs the root store with its options (unused); children carry their route's prefix. */
  constructor(_options?: unknown, private readonly prefix = 'route') {}

  incr(
    key: string,
    callback: (error: Error | null, result?: { current: number; ttl: number }) => void,
    timeWindow: number
  ): void {
    hitCounter(`${this.prefix}:${key}`, timeWindow).then(
      ({ count, ttlMs }) => callback(null, { current: count, ttl: ttlMs }),
      (err: unknown) => callback(err instanceof Error ? err : new Error(String(err)))
    );
  }

  child(routeOptions: Parameters<FastifyRateLimitStore['child']>[0]): FastifyRateLimitStore {
    // The plugin passes the merged limit options, with the route under `routeInfo`.
    const info = (routeOptions as unknown as { routeInfo?: { method?: string | string[]; url?: string } }).routeInfo ?? {};
    const method = Array.isArray(info.method) ? info.method.join(',') : (info.method ?? '');
    return new PgRateLimitStore(undefined, `route:${method} ${info.url ?? ''}`);
  }
}
