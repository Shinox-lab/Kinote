import { eq } from 'drizzle-orm';
import type { ModelSettingsInput } from '@kinote/contracts';
import type { Db } from './client.js';
import { modelSettings } from './schema/usage.js';

/** The control plane's stored model settings, or null when none were set. Not tenant-scoped. */
export async function readModelSettings(db: Pick<Db, 'select'>): Promise<ModelSettingsInput | null> {
  const [row] = await db.select().from(modelSettings).where(eq(modelSettings.id, true));
  if (!row) return null;
  return {
    askModel: row.askModel,
    routerModel: row.routerModel,
    embeddingModel: row.embeddingModel,
    creditRates: row.creditRates ?? null,
  };
}

/** Replaces the stored model settings (one row). */
export async function writeModelSettings(db: Pick<Db, 'insert'>, value: ModelSettingsInput): Promise<void> {
  const values = { ...value, updatedAt: new Date() };
  await db.insert(modelSettings).values({ id: true, ...values }).onConflictDoUpdate({ target: modelSettings.id, set: values });
}
