/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Collab websocket URL; default is `/collab` on the page's own host (see lib/collab.ts). */
  readonly VITE_COLLAB_URL?: string;
}
