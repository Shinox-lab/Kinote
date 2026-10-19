// Where `vite dev` proxies /api and /collab. The stack publishes the api and the
// collab server on host ports that default to 8787 and 1234 and can be changed in
// the repo's .env (API_HOST_PORT, COLLAB_HOST_PORT), for a machine where those are
// taken; the console follows them. API_URL and COLLAB_URL override everything.

const DEFAULT_API_PORT = 8787;
const DEFAULT_COLLAB_PORT = 1234;

/** A port number written as plain digits (1–65535); anything else is not one. */
function parsePort(text: string | undefined): number | undefined {
  if (text === undefined || !/^\d{1,5}$/.test(text)) return undefined;
  const n = Number(text);
  return n >= 1 && n <= 65535 ? n : undefined;
}

export function devTargets(env: Record<string, string | undefined>): { apiUrl: string; collabUrl: string } {
  return {
    apiUrl: env.API_URL || `http://127.0.0.1:${parsePort(env.API_HOST_PORT) ?? DEFAULT_API_PORT}`,
    collabUrl: env.COLLAB_URL || `http://127.0.0.1:${parsePort(env.COLLAB_HOST_PORT) ?? DEFAULT_COLLAB_PORT}`,
  };
}
