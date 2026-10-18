import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as foundations from './schema/foundations.js';
import * as pagesAndIndex from './schema/pages_and_index.js';

export const schema = { ...foundations, ...pagesAndIndex };

/** Driver-agnostic Drizzle database: node-postgres in production, PGlite in tests. */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;
export type DbTransaction = Parameters<Parameters<Db['transaction']>[0]>[0];
/** @deprecated use `Db`. */
export type DbClient = Db;

export interface InitDbOptions {
  url: string;
  /** Maximum pool size (node-postgres default when omitted). */
  max?: number;
}

/**
 * Source for `initDb`: a connection URL (production) or an already built
 * Drizzle instance with an optional shutdown hook (tests build one over PGlite
 * in `testing.ts`, so `drizzle-orm/pglite` is never imported by service code).
 */
export type DbSource = InitDbOptions | { db: Db; close?: () => Promise<void> };

let instance: Db | undefined;
let closer: (() => Promise<void>) | undefined;

/** Creates the process database client. Call once at start-up (or per test file). */
export function initDb(source: DbSource): Db {
  if ('db' in source) {
    instance = source.db;
    closer = source.close;
    return instance;
  }
  const pool = new pg.Pool({ connectionString: source.url, max: source.max });
  instance = drizzle({ client: pool, schema });
  closer = () => pool.end();
  return instance;
}

export function getDb(): Db {
  if (!instance) throw new Error('db not initialised');
  return instance;
}

/** Releases the connection pool and clears the module instance. */
export async function closeDb(): Promise<void> {
  const close = closer;
  instance = undefined;
  closer = undefined;
  if (close) await close();
}

/**
 * Rows of a raw `execute()` result. `Db` is driver-agnostic, so the result is
 * typed `unknown`; node-postgres and PGlite both return `{ rows }`.
 */
export function rowsOf<T = Record<string, unknown>>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return (result as { rows: T[] }).rows;
}
