import { eq, lt, sql } from 'drizzle-orm';
import { getDb, rowsOf } from './client.js';
import { rateLimitCounters } from './schema/rateLimits.js';

/** One counter after a hit: how many hits this window holds, and how long until it starts over. */
export interface CounterState {
  count: number;
  /** Milliseconds until the window ends (at least 0). */
  ttlMs: number;
}

/**
 * Counts one hit on `key` in a fixed window of `windowMs`, atomically, and
 * returns the count so far. The first hit, or the first after the window
 * ended, starts a new window at 1. Uses the database clock, so every process
 * agrees on when a window ends.
 */
export async function hitCounter(key: string, windowMs: number): Promise<CounterState> {
  const window = sql`make_interval(secs => ${windowMs / 1000})`;
  const result = await getDb().execute(sql`
    INSERT INTO ${rateLimitCounters} AS c (key, count, reset_at)
    VALUES (${key}, 1, now() + ${window})
    ON CONFLICT (key) DO UPDATE SET
      count = CASE WHEN c.reset_at <= now() THEN 1 ELSE c.count + 1 END,
      reset_at = CASE WHEN c.reset_at <= now() THEN now() + ${window} ELSE c.reset_at END
    RETURNING c.count AS count,
      greatest(0, ceil(extract(epoch FROM (c.reset_at - now())) * 1000))::bigint AS ttl_ms
  `);
  const row = rowsOf<{ count: number | string; ttl_ms: number | string }>(result)[0]!;
  return { count: Number(row.count), ttlMs: Number(row.ttl_ms) };
}

/** The count of `key`'s current window without counting a hit (0 when there is none). */
export async function readCounter(key: string): Promise<CounterState> {
  const result = await getDb().execute(sql`
    SELECT count,
      greatest(0, ceil(extract(epoch FROM (reset_at - now())) * 1000))::bigint AS ttl_ms
    FROM ${rateLimitCounters}
    WHERE key = ${key} AND reset_at > now()
  `);
  const row = rowsOf<{ count: number | string; ttl_ms: number | string }>(result)[0];
  return row ? { count: Number(row.count), ttlMs: Number(row.ttl_ms) } : { count: 0, ttlMs: 0 };
}

/** Whether a hit on `key` is within `max` per `windowMs`, counting it either way. */
export async function hitLimit(
  key: string,
  max: number,
  windowMs: number
): Promise<{ allowed: boolean; count: number; retryAfterMs: number }> {
  const { count, ttlMs } = await hitCounter(key, windowMs);
  return { allowed: count <= max, count, retryAfterMs: count <= max ? 0 : ttlMs };
}

/** Forgets `key` (e.g. failed sign-ins after a successful one). */
export async function clearCounter(key: string): Promise<void> {
  await getDb().delete(rateLimitCounters).where(eq(rateLimitCounters.key, key));
}

/** Deletes windows that ended more than `graceMs` ago; returns how many. */
export async function deleteExpiredCounters(graceMs = 60 * 60 * 1000): Promise<number> {
  const deleted = await getDb()
    .delete(rateLimitCounters)
    .where(lt(rateLimitCounters.resetAt, sql`now() - make_interval(secs => ${graceMs / 1000})`))
    .returning({ key: rateLimitCounters.key });
  return deleted.length;
}

/** The UTC day `now` falls in (YYYY-MM-DD) and the milliseconds until it ends. */
function utcDay(now: Date): { day: string; msLeft: number } {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return { day: now.toISOString().slice(0, 10), msLeft: next - now.getTime() };
}

/** Kept a little past the day's end, so the counter outlives clock skew between processes. */
const AI_DAY_WINDOW_MS = 25 * 60 * 60 * 1000;

const aiKey = (tenantId: string, day: string) => `ai:${tenantId}:${day}`;

/**
 * Counts one AI action (an Ask, a capture routing, a page card, ...) against a
 * workspace's allowance for the current UTC day. `dailyLimit` 0 means no
 * allowance: nothing is counted. Over the allowance, `retryAfterMs` is the
 * time until the day ends.
 */
export async function chargeAiAction(
  tenantId: string,
  dailyLimit: number,
  now: Date = new Date()
): Promise<{ allowed: boolean; retryAfterMs: number }> {
  if (dailyLimit <= 0) return { allowed: true, retryAfterMs: 0 };
  const { day, msLeft } = utcDay(now);
  const { count } = await hitCounter(aiKey(tenantId, day), AI_DAY_WINDOW_MS);
  return count <= dailyLimit ? { allowed: true, retryAfterMs: 0 } : { allowed: false, retryAfterMs: msLeft };
}

/** Whether a workspace still has AI actions left today, without counting one. */
export async function hasAiActionsLeft(tenantId: string, dailyLimit: number, now: Date = new Date()): Promise<boolean> {
  if (dailyLimit <= 0) return true;
  const { count } = await readCounter(aiKey(tenantId, utcDay(now).day));
  return count < dailyLimit;
}

/** The start of the next UTC day: when a workspace's AI allowance is renewed. */
export function nextAiDay(now: Date = new Date()): Date {
  return new Date(now.getTime() + utcDay(now).msLeft);
}
