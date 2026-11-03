// Failed sign-ins counted per account (the per-IP limit can't see a guessing
// run spread across many addresses). Five failures within 15 minutes lock the
// email for 1 minute; each further lock within a day doubles, up to 15
// minutes. There is no permanent lockout, so someone who knows an email can
// slow its owner down for a while but never shut them out. Unknown emails are
// counted exactly like real ones, so the throttle says nothing about which
// emails have accounts. The counters live in Postgres (rate_limit_counters),
// shared by every api process; if they can't be read, sign-in fails (500)
// rather than going unthrottled.
import type { FastifyReply } from 'fastify';
import { AppError } from '@kinote/contracts';
import { clearCounter, hitCounter, readCounter } from '@kinote/db';
import { sha256Hex } from '@kinote/shared';

export const MAX_FAILED_SIGN_INS = 5;
const FAIL_WINDOW_MS = 15 * 60 * 1000;
const LEVEL_WINDOW_MS = 24 * 60 * 60 * 1000;
const FIRST_LOCK_MS = 60 * 1000;
const MAX_LOCK_MS = 15 * 60 * 1000;

/** The counter keys of one email: never the address itself. */
function keysOf(email: string) {
  const id = sha256Hex(email.trim().toLowerCase());
  return { fails: `signin-fail:${id}`, lock: `signin-lock:${id}`, level: `signin-level:${id}` };
}

/** Refuses with rate_limited (and Retry-After) while the email is locked. */
export async function assertSignInAllowed(email: string, reply: FastifyReply): Promise<void> {
  const lock = await readCounter(keysOf(email).lock);
  if (lock.count > 0) {
    reply.header('retry-after', Math.max(1, Math.ceil(lock.ttlMs / 1000)));
    throw new AppError('rate_limited');
  }
}

/** Counts a failed sign-in; the fifth in a window locks the email. */
export async function recordFailedSignIn(email: string): Promise<void> {
  const keys = keysOf(email);
  const { count } = await hitCounter(keys.fails, FAIL_WINDOW_MS);
  if (count < MAX_FAILED_SIGN_INS) return;
  const { count: level } = await hitCounter(keys.level, LEVEL_WINDOW_MS);
  const lockMs = Math.min(MAX_LOCK_MS, FIRST_LOCK_MS * 2 ** (level - 1));
  await hitCounter(keys.lock, lockMs);
  await clearCounter(keys.fails);
}

/** A successful sign-in forgets the email's failures and backoff. */
export async function recordSuccessfulSignIn(email: string): Promise<void> {
  const keys = keysOf(email);
  await Promise.all([clearCounter(keys.fails), clearCounter(keys.level)]);
}
