/** The one index width this release supports. The database columns are halfvec(2560). */
export const EMBEDDING_DIMENSIONS = 2560;

export interface EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
}

/**
 * Deterministic token-aware embedding provider for repeatable local and CI evaluation.
 * Produces L2-normalized vectors in halfvec(2560) space so semantically overlapping queries
 * and chunks rank naturally via cosine distance (<=>).
 */
export class DeterministicEmbeddingProvider implements EmbeddingProvider {
  readonly model = 'living-wiki-deterministic-2560-v1';
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
