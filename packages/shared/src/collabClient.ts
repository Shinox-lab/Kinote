import { AppError, type CollabApplyBlockOpsRequest } from '@living-wiki/contracts';
import { documentName } from './collabToken.js';

/**
 * The API's handle on the collab server's internal endpoints: the live page
 * document lives there, so storing it or changing it goes through collab.
 */
export interface CollabClient {
  /** Stores the live document now (no-op when it is not loaded). */
  flush(documentName: string): Promise<void>;
  /**
   * Replaces the live page's blocks and title, attributed to `actor` with `source`.
   *
   * Never call it while holding `lockDocument` on that page: the edit's
   * authorship bookkeeping in collab takes FOR KEY SHARE on the same document
   * row and the call waits for it, so the two processes would wait on each
   * other until the call times out (COLLAB_CALL_TIMEOUT_MS).
   */
  replaceBlocks(a: {
    tenantId: string;
    pageId: string;
    blocks: unknown[];
    title: string;
    actor: { type: 'user' | 'agent'; id: string };
    source: 'restore' | 'agent';
    /** When given, the page's whole `fields` map becomes these values. */
    fields?: Record<string, unknown>;
  }): Promise<void>;
  /**
   * Changes single top-level blocks of a live page in one attributed change
   * (`agent` by an agent, `human` by a user). A block that is not on the page
   * is `block_not_found`, one whose text is not an op's `expectedText` is
   * `block_changed`; either way nothing changes.
   *
   * Never call it while holding `lockDocument` on that page, for the same
   * reason as `replaceBlocks`.
   */
  applyBlockOps(a: {
    tenantId: string;
    pageId: string;
    actor: { type: 'user' | 'agent'; id: string };
    source: 'agent' | 'human';
    ops: CollabApplyBlockOpsRequest['ops'];
  }): Promise<void>;
  /**
   * Renames a live page (its title only; the blocks are untouched),
   * attributed to `actor` as a human change: the title is part of the
   * indexed text, so a rename is a content change.
   *
   * Never call it while holding `lockDocument` on that page, for the same
   * reason as `replaceBlocks`.
   */
  setTitle(a: {
    tenantId: string;
    pageId: string;
    title: string;
    actor: { type: 'user' | 'agent'; id: string };
  }): Promise<void>;
  /**
   * Sets field values of a live page (null removes one) in one attributed
   * change. Values are not checked by collab: check them first.
   *
   * Never call it while holding `lockDocument` on that page, for the same
   * reason as `replaceBlocks`.
   */
  setFields(a: {
    tenantId: string;
    pageId: string;
    values: Record<string, unknown>;
    actor: { type: 'user' | 'agent'; id: string };
    source: 'human' | 'agent';
  }): Promise<void>;
  /**
   * Closes the live editing connections of a tenant (only `userId`'s when
   * given), so they reconnect and authenticate with the current role. Call it
   * after the access change committed, never inside a transaction.
   */
  revoke(target: { tenantId: string; userId?: string }): Promise<void>;
}

/** How long one internal call may take before it is abandoned. */
export const COLLAB_CALL_TIMEOUT_MS = 5_000;

/**
 * Calls the collab internal endpoints over HTTP with the shared secret in
 * `x-internal-secret`. Success is 204 No Content, what the internal
 * endpoints answer, and nothing else: any other status (a 200 page from
 * something that is not the collab server, a redirect, an error),
 * unreachable or timeout is an `internal_error`: the caller must not carry
 * on as if the call succeeded.
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
      ...(a.fields !== undefined ? { fields: a.fields } : {}),
    });
  }

  async setFields(a: Parameters<CollabClient['setFields']>[0]): Promise<void> {
    await this.#post('/internal/set-fields', {
      documentName: documentName(a.tenantId, a.pageId),
      actor: a.actor,
      source: a.source,
      values: a.values,
    });
  }

  async applyBlockOps(a: Parameters<CollabClient['applyBlockOps']>[0]): Promise<void> {
    await this.#post('/internal/apply-block-ops', {
      documentName: documentName(a.tenantId, a.pageId),
      actor: a.actor,
      source: a.source,
      ops: a.ops,
    });
  }

  async setTitle(a: Parameters<CollabClient['setTitle']>[0]): Promise<void> {
    await this.#post('/internal/set-title', {
      documentName: documentName(a.tenantId, a.pageId),
      title: a.title,
      actor: a.actor,
    });
  }

  async revoke(target: { tenantId: string; userId?: string }): Promise<void> {
    await this.#post('/internal/revoke', {
      tenant_id: target.tenantId,
      ...(target.userId !== undefined ? { user_id: target.userId } : {}),
    });
  }

  async #post(path: string, body: unknown): Promise<void> {
    let res: Response;
    try {
      res = await fetch(`${this.#baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-internal-secret': this.#secret },
        body: JSON.stringify(body),
        // A redirect is not the collab server answering: never follow one.
        redirect: 'manual',
        signal: AbortSignal.timeout(COLLAB_CALL_TIMEOUT_MS),
      });
    } catch (err) {
      console.error(
        `[api] collab ${path} unreachable:`,
        err instanceof Error ? err.message : String(err)
      );
      throw new AppError('internal_error');
    }
    if (res.status === 404) {
      // The one refusal callers act on: the block they addressed is gone.
      const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
      if (body?.error === 'block_not_found') throw new AppError('block_not_found');
      console.error(`[api] collab ${path} answered 404`);
      throw new AppError('internal_error');
    }
    if (res.status === 409) {
      const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
      if (body?.error === 'block_changed') throw new AppError('block_changed');
      console.error(`[api] collab ${path} answered 409`);
      throw new AppError('internal_error');
    }
    if (res.status !== 204) {
      // Drain the body so the connection can be reused; log only the status.
      await res.arrayBuffer().catch(() => undefined);
      console.error(`[api] collab ${path} answered ${res.status}`);
      throw new AppError('internal_error');
    }
    await res.arrayBuffer().catch(() => undefined);
  }
}
