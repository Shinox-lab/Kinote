/** The one index width this release supports. The database columns are halfvec(2560). */
export const EMBEDDING_DIMENSIONS = 2560;

import { AppError } from '@kinote/contracts';

export type EmbeddingKind = 'document' | 'query';

export interface EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;
  embed(texts: string[], kind?: EmbeddingKind): Promise<number[][]>;
}

/**
 * Deterministic token-aware embedding provider for repeatable local and CI evaluation.
 * Produces L2-normalized vectors in halfvec(2560) space so semantically overlapping queries
 * and chunks rank naturally via cosine distance (<=>).
 */
export class DeterministicEmbeddingProvider implements EmbeddingProvider {
  readonly model = 'kinote-deterministic-2560-v1';
  readonly dimensions = EMBEDDING_DIMENSIONS;
  public callCount = 0;

  async embed(texts: string[]): Promise<number[][]> {
    this.callCount += 1;
    return texts.map((text) => {
      const vec = new Array<number>(this.dimensions).fill(0);
      const tokens = text
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(Boolean);

      for (const tok of tokens) {
        let h1 = 2166136261;
        let h2 = 16777619;
        for (let i = 0; i < tok.length; i++) {
          h1 ^= tok.charCodeAt(i);
          h1 = Math.imul(h1, 16777619);
          h2 ^= tok.charCodeAt(i) * (i + 1);
          h2 = Math.imul(h2, 1099511627);
        }
        const idx1 = Math.abs(h1) % this.dimensions;
        const idx2 = Math.abs(h2) % this.dimensions;
        vec[idx1] += 1.0;
        vec[idx2] += 0.5;
      }

      let norm = Math.sqrt(vec.reduce((acc, v) => acc + v * v, 0));
      if (norm === 0) {
        vec[0] = 1;
        norm = 1;
      }
      return vec.map((v) => Number((v / norm).toFixed(6)));
    });
  }
}

export const defaultEmbeddingProvider = new DeterministicEmbeddingProvider();

/** A failure the caller may show: the contract sentence, never the provider's body or key. */
function unavailable(cause: string): AppError {
  const error = new AppError('embedding_unavailable');
  error.cause = new Error(cause);
  return error;
}

/**
 * An OpenAI-compatible `/embeddings` client. The index width is fixed at 2560;
 * a provider that ignores `dimensions` and returns another width is rejected
 * rather than silently truncated.
 */
export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly model: string;
  readonly dimensions = EMBEDDING_DIMENSIONS;
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly batchSize: number;
  private readonly timeoutMs: number;
  private readonly queryInstruction: string | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: {
    baseUrl: string;
    apiKey?: string;
    model: string;
    batchSize: number;
    timeoutMs: number;
    queryInstruction?: string;
    fetchImpl?: typeof fetch;
  }) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.batchSize = opts.batchSize;
    this.timeoutMs = opts.timeoutMs;
    this.queryInstruction = opts.queryInstruction;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async embed(texts: string[], kind: EmbeddingKind = 'document'): Promise<number[][]> {
    const out: number[][] = [];
    for (let start = 0; start < texts.length; start += this.batchSize) {
      const batch = texts.slice(start, start + this.batchSize);
      out.push(...(await this.embedBatch(batch, kind)));
    }
    return out;
  }

  private async embedBatch(texts: string[], kind: EmbeddingKind): Promise<number[][]> {
    const input = texts.map((text) =>
      kind === 'query' && this.queryInstruction
        ? `Instruct: ${this.queryInstruction}\nQuery: ${text}`
        : text
    );

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/embeddings`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify({ model: this.model, input, dimensions: this.dimensions }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      throw unavailable(timedOut ? 'the embedding service did not answer in time' : 'the embedding service could not be reached');
    }

    if (!response.ok) throw unavailable(`the embedding service answered ${response.status}`);

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw unavailable('the embedding service returned an unexpected answer');
    }
    const rows = (body as { data?: unknown })?.data;
    if (!Array.isArray(rows) || rows.length !== texts.length) {
      throw unavailable('the embedding service returned an unexpected answer');
    }

    const ordered: Array<number[] | undefined> = new Array(texts.length);
    for (const row of rows) {
      const index = (row as { index?: unknown })?.index;
      const embedding = (row as { embedding?: unknown })?.embedding;
      if (
        !Number.isInteger(index) ||
        (index as number) < 0 ||
        (index as number) >= texts.length ||
        ordered[index as number] !== undefined ||
        !Array.isArray(embedding) ||
        embedding.length !== this.dimensions ||
        !embedding.every((value) => typeof value === 'number' && Number.isFinite(value))
      ) {
        throw unavailable('the embedding service returned an unexpected answer');
      }
      ordered[index as number] = embedding;
    }
    if (ordered.some((value) => value === undefined)) {
      throw unavailable('the embedding service returned an unexpected answer');
    }
    return ordered as number[][];
  }
}

/** The embedding provider the settings ask for. */
export function createEmbeddingProvider(config: {
  EMBEDDING_PROVIDER: 'deterministic' | 'openai';
  EMBEDDING_BASE_URL?: string;
  EMBEDDING_API_KEY?: string;
  EMBEDDING_MODEL?: string;
  EMBEDDING_BATCH_SIZE: number;
  EMBEDDING_TIMEOUT_MS: number;
  EMBEDDING_QUERY_INSTRUCTION?: string;
}): EmbeddingProvider {
  if (config.EMBEDDING_PROVIDER === 'deterministic') return new DeterministicEmbeddingProvider();
  if (!config.EMBEDDING_BASE_URL || !config.EMBEDDING_MODEL) {
    throw new Error('EMBEDDING_BASE_URL and EMBEDDING_MODEL are required for the openai provider');
  }
  return new OpenAIEmbeddingProvider({
    baseUrl: config.EMBEDDING_BASE_URL,
    apiKey: config.EMBEDDING_API_KEY,
    model: config.EMBEDDING_MODEL,
    batchSize: config.EMBEDDING_BATCH_SIZE,
    timeoutMs: config.EMBEDDING_TIMEOUT_MS,
    queryInstruction: config.EMBEDDING_QUERY_INSTRUCTION,
  });
}
