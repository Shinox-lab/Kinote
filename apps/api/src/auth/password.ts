import { randomBytes } from 'node:crypto';
import { hash, verify, type Algorithm } from '@node-rs/argon2';
import { AppError } from '@kinote/contracts';
import { COMMON_PASSWORDS } from './commonPasswords.js';

// `Algorithm` is an ambient const enum, which isolatedModules cannot inline;
// 2 is Algorithm.Argon2id (also the library default — set explicitly here).
const ARGON2ID = 2 as Algorithm;

/** Hashes a password with argon2id (library-default cost parameters). */
export function hashPassword(pw: string): Promise<string> {
  return hash(pw, { algorithm: ARGON2ID });
}

/**
 * Verifies a password against a stored hash. Never throws: a malformed or
 * placeholder hash (e.g. '!') simply does not verify.
 */
export async function verifyPassword(pw: string, storedHash: string): Promise<boolean> {
  try {
    return await verify(storedHash, pw);
  } catch {
    return false;
  }
}

let common: Set<string> | null = null;

/**
 * Refuses a new password that is easy to guess: one of the most common
 * passwords (any case), or the account's own email address. The length
 * minimum is the request schemas' job; this list holds only passwords at
 * least that long. Throws 400 `password_too_common`.
 */
export function assertPasswordAllowed(password: string, email?: string): void {
  common ??= new Set(COMMON_PASSWORDS);
  const lower = password.toLowerCase();
  const address = email?.toLowerCase();
  if (common.has(lower) || (address && (lower === address || lower === address.split('@')[0]))) {
    throw new AppError('password_too_common');
  }
}

export function isUsableHash(storedHash: string): boolean {
  return storedHash.startsWith('$argon2');
}

let dummyHash: Promise<string> | null = null;

/**
 * A real argon2id hash of a random secret, computed once. Sign-in verifies
 * against it when the email is unknown (or the account has no usable
 * password) so every failure costs the same work.
 */
export function getDummyHash(): Promise<string> {
  dummyHash ??= hashPassword(randomBytes(32).toString('base64url'));
  return dummyHash;
}
