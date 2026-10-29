import type { Source, SourceToken } from '@kinote/contracts';
import { relativeTime } from './updates.js';

// Words and commands of the Sources screen.

/** Inside double quotes the shell still acts on these; a token is URL-safe, so this is only a guard. */
const inDoubleQuotes = (s: string): string => s.replace(/[\\"$`]/g, '\\$&');

/** The two calls a script makes, with a real token, for the address the console is served from. */
export function curlExamples({ apiBase, token }: { apiBase: string; token: string }): { put: string; delete: string } {
  const base = apiBase.replace(/\/+$/, '');
  const auth = `-H "Authorization: Bearer ${inDoubleQuotes(token)}"`;
  const url = `"${inDoubleQuotes(base)}/api/v1/source/files/reports/2026-q3"`;
  return {
    put: `curl -X PUT ${auth} -F "file=@report.pdf" ${url}`,
    delete: `curl -X DELETE ${auth} ${url}`,
  };
}

export function sourceStatusLabel(source: Pick<Source, 'status'>): string {
  return source.status === 'paused' ? 'Paused' : 'Active';
}

/** A revoked token stays revoked even once its expiry has passed. */
export function tokenState(token: SourceToken, now: Date): 'active' | 'revoked' | 'expired' {
  if (token.revokedAt !== null) return 'revoked';
  if (token.expiresAt !== null && Date.parse(token.expiresAt) <= now.getTime()) return 'expired';
  return 'active';
}

export function lastUsedLabel(token: Pick<SourceToken, 'lastUsedAt'>, now: Date): string {
  if (token.lastUsedAt === null) return 'Never used';
  const when = relativeTime(token.lastUsedAt, now);
  return when === 'just now' ? 'Used just now' : `Used ${when} ago`;
}
