import type { Config } from '@kinote/shared';
import { createAnswerProvider, type AnswerProvider } from '../answer.js';
import { createEmbeddingProvider, EMBEDDING_DIMENSIONS, type EmbeddingProvider } from '../embedding.js';
import { createPlacementModel, type RoutingModel } from '../placement/model.js';
import type { ModelSettingsCache } from './settings.js';

// Providers are chosen by model id when they are used, not once at startup: the deployment's models come from
// the settings cache, Ask's from the workspace. One provider per model id is built and kept. Endpoints and keys
// stay in the env (EMBEDDING_BASE_URL, ASK_API_KEY …); only the model id changes.

/** Builds a provider for a model id (null: the env's). */
export interface ModelFactories {
  answer(model: string | null): AnswerProvider;
  embedding(model: string | null): EmbeddingProvider;
  routing(model: string | null): RoutingModel;
}

/** The env's factories: the configured provider kind and endpoint, with the model id swapped in. */
export function modelFactoriesFrom(config: Config): ModelFactories {
  return {
    answer: (model) => createAnswerProvider({ ...config, ASK_MODEL: model ?? config.ASK_MODEL }),
    embedding: (model) => createEmbeddingProvider({ ...config, EMBEDDING_MODEL: model ?? config.EMBEDDING_MODEL }),
    routing: (model) => createPlacementModel({ ...config, ROUTER_MODEL: model ?? config.ROUTER_MODEL }),
  };
}

/** An object that forwards every property read to whatever `get()` returns now (methods bound to it). */
export function delegating<T extends object>(get: () => T): T {
  return new Proxy({} as T, {
    get(_target, prop) {
      const target = get();
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
    has(_target, prop) {
      return Reflect.has(get(), prop);
    },
  });
}

export class ModelProviders {
  private readonly answers = new Map<string, AnswerProvider>();
  private readonly embeddings = new Map<string, EmbeddingProvider>();
  private readonly routers = new Map<string, RoutingModel>();
  private readonly embeddingView = delegating(() => this.cached(this.embeddings, this.cache.current().embeddingModel, this.factories.embedding));
  private readonly routingView = delegating(() => this.cached(this.routers, this.cache.current().routerModel, this.factories.routing));

  constructor(
    readonly cache: ModelSettingsCache,
    readonly factories: ModelFactories
  ) {}

  private cached<P>(map: Map<string, P>, model: string | null, build: (model: string | null) => P): P {
    const key = model ?? '';
    let provider = map.get(key);
    if (!provider) {
      provider = build(model);
      map.set(key, provider);
    }
    return provider;
  }

  /** The embedding provider for one model id (kept), unlike embedding() which follows the settings. */
  embeddingFor(model: string | null): EmbeddingProvider {
    return this.cached(this.embeddings, model, this.factories.embedding);
  }

  /** The routing model for one model id (kept). */
  routingFor(model: string | null): RoutingModel {
    return this.cached(this.routers, model, this.factories.routing);
  }

  /** The answer provider for a workspace's model; null uses the deployment's. */
  answerFor(askModel: string | null): AnswerProvider {
    return this.cached(this.answers, askModel ?? this.cache.current().askModel, this.factories.answer);
  }

  /** The deployment's embedding provider; follows the settings as they change. */
  embedding(): EmbeddingProvider {
    return this.embeddingView;
  }

  /** The deployment's routing model; follows the settings as they change. */
  routing(): RoutingModel {
    return this.routingView;
  }

  /** Embeds one text with `model` (a fresh provider, not kept); throws unless it works and gives EMBEDDING_DIMENSIONS. */
  async probeEmbedding(model: string): Promise<void> {
    const provider = this.factories.embedding(model);
    const [vector] = await provider.embed(['dimension probe'], 'document');
    const width = vector?.length ?? 0;
    if (width !== EMBEDDING_DIMENSIONS) {
      throw new Error(`"${model}" returns ${width}-dimension vectors; the index needs ${EMBEDDING_DIMENSIONS}`);
    }
  }
}
