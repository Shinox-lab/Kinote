import type { AuthResponse } from '@living-wiki/contracts';
import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query';
import { isUnauthenticated } from './api.js';
import { clearSession, saveSession } from './session.js';

let onUnauthenticated: () => void = () => {};

/** What to do once the session is gone (the router sends the user to /sign-in). */
export function setUnauthenticatedHandler(handler: () => void): void {
  onUnauthenticated = handler;
}

/** Forgets the session and every cached answer that belonged to it. */
export function endSession(): void {
  clearSession();
  queryClient.clear();
}

function onError(err: unknown): void {
  // The API says the session is no longer valid: drop it and go to sign-in.
  if (isUnauthenticated(err)) {
    endSession();
    onUnauthenticated();
  }
}

export const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError }),
  mutationCache: new MutationCache({ onError }),
  defaultOptions: {
    // A failed read shows its sentence; the user retries by acting, not by silent polling.
    queries: { retry: false, refetchOnWindowFocus: false, staleTime: 15_000 },
  },
});

/** Starts the session of a fresh sign-in or sign-up; the workspace is chosen once the shell opens one. */
export function startSession(auth: AuthResponse): void {
  queryClient.clear();
  saveSession({ token: auth.session.token, user: auth.user, tenantId: null, tenantSlug: null });
}
