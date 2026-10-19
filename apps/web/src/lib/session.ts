// The console's one session: what the api client sends (bearer token, tenant)
// and what the shell shows (who is signed in, which workspace was last open).
// Kept in localStorage; every access is guarded, because storage can be
// missing or throw (private windows, blocked site data, tests).

export interface Session {
  /** The opaque `lws_` bearer token. */
  token: string;
  user: { id: string; name: string; email: string };
  /** The workspace the requests act in (x-tenant-id); null until one is chosen. */
  tenantId: string | null;
  tenantSlug: string | null;
}

const SESSION_KEY = 'living-wiki.session';

const isString = (v: unknown): v is string => typeof v === 'string';
const isStringOrNull = (v: unknown): v is string | null => v === null || typeof v === 'string';

/** The stored value as a Session, or null when it is not exactly that shape. */
function parseSession(value: unknown): Session | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const { token, user, tenantId, tenantSlug } = value as Record<string, unknown>;
  if (!isString(token) || token === '') return null;
  if (typeof user !== 'object' || user === null) return null;
  const { id, name, email } = user as Record<string, unknown>;
  if (!isString(id) || !isString(name) || !isString(email)) return null;
  if (!isStringOrNull(tenantId) || !isStringOrNull(tenantSlug)) return null;
  return { token, user: { id, name, email }, tenantId, tenantSlug };
}

/** The saved session; null when there is none, storage is unavailable or the stored value is malformed. */
export function loadSession(): Session | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw === null ? null : parseSession(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** Remembers the session across reloads (only the fields of Session; nothing else is stored). */
export function saveSession(session: Session): void {
  const { token, user, tenantId, tenantSlug } = session;
  try {
    localStorage.setItem(
      SESSION_KEY,
      JSON.stringify({ token, user: { id: user.id, name: user.name, email: user.email }, tenantId, tenantSlug })
    );
  } catch {
    // Storage unavailable: the user signs in again after a reload.
  }
}

export function clearSession(): void {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    // Nothing to clear.
  }
}
