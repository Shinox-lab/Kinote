import { createHash } from 'node:crypto';

/** Lower-case hex SHA-256 of a UTF-8 string. Used to store secrets (session tokens) by digest only. */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}
