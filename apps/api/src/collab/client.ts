import { AppError } from '@living-wiki/contracts';
import { documentName } from '@living-wiki/shared';

/**
 * The API's handle on the collab server's internal endpoints: the live page
 * document lives there, so storing it or changing it goes through collab.
 */
export interface CollabClient {
  /** Stores the live document now (no-op when it is not loaded). */
  flush(documentName: string): Promise<void>;
  /** Replaces the live page's blocks and title, attributed to `actor` with `source`. */
  replaceBlocks(a: {
    tenantId: string;
    pageId: string;
    blocks: unknown[];
    title: string;
    actor: { type: 'user' | 'agent'; id: string };
    source: 'restore' | 'agent';
  }): Promise<void>;
}

/** How long one internal call may take before it is abandoned. */
export const COLLAB_CALL_TIMEOUT_MS = 5_000;

/**
 * Calls the collab internal endpoints over HTTP with the shared secret in
 * `x-internal-secret`. Any failure (unreachable, timeout, non-2xx) is an
 * `internal_error`: the caller must not carry on as if the call succeeded.
 * The secret is never logged.
 */
export class HttpCollabClient implements CollabClient {
  readonly #baseUrl: string;
  readonly #secret: string;

  constructor(baseUrl: string, secret: string) {
    this.#baseUrl = baseUrl.replace(/\/+$/, '');
    this.#secret = secret;
  }

  async flush(name: string): Promise<void> {
    await this.#post('/internal/flush', { documentName: name });
  }

  async replaceBlocks(a: Parameters<CollabClient['replaceBlocks']>[0]): Promise<void> {
    await this.#post('/internal/replace-blocks', {
      documentName: documentName(a.tenantId, a.pageId),
      title: a.title,
      blocks: a.blocks,
      actor: a.actor,
      source: a.source,
    });
  }

  async #post(path: string, body: unknown): Promise<void> {
    let res: Response;
    try {
      res = await fetch(`${this.#baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-internal-secret': this.#secret },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(COLLAB_CALL_TIMEOUT_MS),
      });
    } catch (err) {
      console.error(
        `[api] collab ${path} unreachable:`,
        err instanceof Error ? err.message : String(err)
      );
      throw new AppError('internal_error');
    }
    if (!res.ok) {
      // Drain the body so the connection can be reused; log only the status.
      await res.arrayBuffer().catch(() => undefined);
      console.error(`[api] collab ${path} answered ${res.status}`);
      throw new AppError('internal_error');
    }
    await res.arrayBuffer().catch(() => undefined);
  }
}
