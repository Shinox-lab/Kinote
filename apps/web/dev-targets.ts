// Where `vite dev` proxies /api, /collab and /gridcraft. The stack publishes the api,
// collab server and GridCraft editor on host ports that default to 8787, 1234 and
// 8082 and can be changed in the repo's .env (API_HOST_PORT, COLLAB_HOST_PORT,
// GRIDCRAFT_HOST_PORT), for a machine where those are taken; the console follows
// them. API_URL, COLLAB_URL and GRIDCRAFT_URL override everything.

const DEFAULT_API_PORT = 8787;
const DEFAULT_COLLAB_PORT = 1234;
const DEFAULT_GRIDCRAFT_PORT = 8082;

/** A port number written as plain digits (1–65535); anything else is not one. */
function parsePort(text: string | undefined): number | undefined {
  if (text === undefined || !/^\d{1,5}$/.test(text)) return undefined;
  const n = Number(text);
  return n >= 1 && n <= 65535 ? n : undefined;
}

export function devTargets(env: Record<string, string | undefined>): {
  apiUrl: string;
  collabUrl: string;
  gridcraftUrl: string;
} {
  return {
    apiUrl: env.API_URL || `http://127.0.0.1:${parsePort(env.API_HOST_PORT) ?? DEFAULT_API_PORT}`,
    collabUrl: env.COLLAB_URL || `http://127.0.0.1:${parsePort(env.COLLAB_HOST_PORT) ?? DEFAULT_COLLAB_PORT}`,
    gridcraftUrl:
      env.GRIDCRAFT_URL || `http://127.0.0.1:${parsePort(env.GRIDCRAFT_HOST_PORT) ?? DEFAULT_GRIDCRAFT_PORT}`,
  };
}
