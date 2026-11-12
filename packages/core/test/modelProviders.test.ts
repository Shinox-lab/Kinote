import { describe, expect, it } from 'vitest';
import type { ModelSettingsInput } from '@kinote/contracts';
import {
  defaultAnswerProvider,
  defaultPlacementModel,
  EMBEDDING_DIMENSIONS,
  ModelProviders,
  ModelSettingsCache,
  type EmbeddingProvider,
  type ModelEnv,
  type ModelFactories,
} from '../src/index.js';

const env: ModelEnv = {
  ASK_PROVIDER: 'openai',
  ASK_MODEL: 'ask-default',
  ROUTER_PROVIDER: 'openai',
  ROUTER_MODEL: 'router-default',
  EMBEDDING_PROVIDER: 'openai',
  EMBEDDING_MODEL: 'e1',
  MODEL_CREDIT_RATES: undefined,
};
const none: ModelSettingsInput = { askModel: null, routerModel: null, embeddingModel: null, creditRates: null };

function setup() {
  let stored: ModelSettingsInput = none;
  const built = { answer: [] as (string | null)[], embedding: [] as (string | null)[] };
  const factories: ModelFactories = {
    answer: (model) => {
      built.answer.push(model);
      return { ...defaultAnswerProvider, answer: defaultAnswerProvider.answer.bind(defaultAnswerProvider), model } as never;
    },
    embedding: (model): EmbeddingProvider => {
      built.embedding.push(model);
      return { model: model ?? 'none', dimensions: EMBEDDING_DIMENSIONS, embed: async (t) => t.map(() => new Array(EMBEDDING_DIMENSIONS).fill(0)) };
    },
    routing: () => defaultPlacementModel,
  };
  const cache = new ModelSettingsCache(async () => stored, env);
  const models = new ModelProviders(cache, factories);
  return { models, cache, built, store: (s: Partial<ModelSettingsInput>) => (stored = { ...none, ...s }) };
}

describe('ModelProviders', () => {
  it('embedding() follows the cache', async () => {
    const { models, cache, store } = setup();
    const wrapper = models.embedding();
    expect(wrapper.model).toBe('e1');
    store({ embeddingModel: 'e2' });
    await cache.refresh();
    expect(wrapper.model).toBe('e2');
    expect(wrapper.dimensions).toBe(EMBEDDING_DIMENSIONS);
  });

  it('answerFor caches one provider per model id', () => {
    const { models, built } = setup();
    expect(models.answerFor('m')).toBe(models.answerFor('m'));
    expect(built.answer).toEqual(['m']);
  });

  it("answerFor(null) uses the deployment's ask model", async () => {
    const { models, cache, store, built } = setup();
    models.answerFor(null);
    store({ askModel: 'stored-ask' });
    await cache.refresh();
    models.answerFor(null);
    expect(built.answer).toEqual(['ask-default', 'stored-ask']);
  });

  it('probeEmbedding refuses a wrong width', async () => {
    const { models } = setup();
    const narrow = new ModelProviders(models.cache, {
      ...models.factories,
      embedding: () => ({ model: 'narrow', dimensions: 1024, embed: async () => [new Array(1024).fill(0)] }),
    });
    await expect(narrow.probeEmbedding('narrow')).rejects.toThrow(/1024/);
    await expect(models.probeEmbedding('wide')).resolves.toBeUndefined();
  });
});
