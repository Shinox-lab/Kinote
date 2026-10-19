import { randomBytes } from 'node:crypto';
import { hash, verify, type Algorithm } from '@node-rs/argon2';

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
