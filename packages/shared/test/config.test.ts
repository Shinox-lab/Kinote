import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const base = {
  DATABASE_URL: 'postgres://x',
  COLLAB_TOKEN_SECRET: 'c'.repeat(32),
  INTERNAL_SECRET: 'i'.repeat(32),
};

describe('loadConfig: auth rate limit and embeddings', () => {
  it('defaults to 10 auth attempts a minute and the deterministic provider', () => {
    const config = loadConfig(base);
    expect(config.AUTH_RATE_LIMIT_MAX).toBe(10);
    expect(config.EMBEDDING_PROVIDER).toBe('deterministic');
  });

  it('reads AUTH_RATE_LIMIT_MAX and EMBEDDING_PROVIDER from the environment', () => {
    const config = loadConfig({ ...base, AUTH_RATE_LIMIT_MAX: '1000', EMBEDDING_PROVIDER: 'deterministic' });
    expect(config.AUTH_RATE_LIMIT_MAX).toBe(1000);
  });

  it('refuses a provider it does not know and a limit that is not a positive number', () => {
    expect(() => loadConfig({ ...base, EMBEDDING_PROVIDER: 'openai' })).toThrow(/EMBEDDING_PROVIDER/);
    expect(() => loadConfig({ ...base, AUTH_RATE_LIMIT_MAX: '0' })).toThrow(/AUTH_RATE_LIMIT_MAX/);
  });
});
