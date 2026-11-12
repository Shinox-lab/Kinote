import type { ModelSettingsInput } from '@kinote/contracts';
import { parseCreditRates, type Config, type CreditRates } from '@kinote/shared';

// The deployment's models and rate table: what the control plane stored (model_settings), each field falling
// back to its env var. Every process keeps the effective values in a ModelSettingsCache, refreshed every 30 s
// and right after a PUT in the process that handled it.

export type ModelEnv = Pick<
  Config,
  'ASK_PROVIDER' | 'ASK_MODEL' | 'ROUTER_PROVIDER' | 'ROUTER_MODEL' | 'EMBEDDING_PROVIDER' | 'EMBEDDING_MODEL' | 'MODEL_CREDIT_RATES'
>;

export type ProviderKind = 'deterministic' | 'openai';

export interface EffectiveModelSettings {
  askModel: string | null;
  routerModel: string | null;
  embeddingModel: string | null;
  creditRates: CreditRates | null;
  providers: { ask: ProviderKind; router: ProviderKind; embedding: ProviderKind };
}

/** Stored values win field by field; a null field uses the env. Providers (and endpoints, keys) are env only. */
export function effectiveModelSettings(stored: ModelSettingsInput | null, env: ModelEnv): EffectiveModelSettings {
  return {
    askModel: stored?.askModel ?? env.ASK_MODEL ?? null,
    routerModel: stored?.routerModel ?? env.ROUTER_MODEL ?? null,
    embeddingModel: stored?.embeddingModel ?? env.EMBEDDING_MODEL ?? null,
    creditRates: stored?.creditRates ?? parseCreditRates(env.MODEL_CREDIT_RATES),
    providers: { ask: env.ASK_PROVIDER, router: env.ROUTER_PROVIDER, embedding: env.EMBEDDING_PROVIDER },
  };
}

export const MODEL_SETTINGS_TTL_MS = 30_000;

export class ModelSettingsCache {
  private value: EffectiveModelSettings;

  constructor(
    private readonly load: () => Promise<ModelSettingsInput | null>,
    private readonly env: ModelEnv,
    private readonly ttlMs = MODEL_SETTINGS_TTL_MS
  ) {
    this.value = effectiveModelSettings(null, env);
  }

  /** The effective settings as last loaded (the env alone until the first refresh). */
  current(): EffectiveModelSettings {
    return this.value;
  }

  /** Loads the stored settings now. A failed load is logged and the last value kept. */
  async refresh(): Promise<EffectiveModelSettings> {
    try {
      this.value = effectiveModelSettings(await this.load(), this.env);
    } catch (err) {
      console.error('[models] model settings unavailable; keeping the last ones:', err instanceof Error ? err.message : err);
    }
    return this.value;
  }

  /** Refreshes now and every ttlMs; returns a function that stops it. */
  start(): () => void {
    void this.refresh();
    const timer = setInterval(() => void this.refresh(), this.ttlMs);
    timer.unref();
    return () => clearInterval(timer);
  }
}
