import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as foundations from './schema/foundations.js';
import * as pagesAndIndex from './schema/pages_and_index.js';
import * as placement from './schema/placement.js';
import * as routing from './schema/routing.js';

export const schema = { ...foundations, ...pagesAndIndex, ...placement, ...routing };

/** Driver-agnostic Drizzle database: node-postgres in production, PGlite in tests. */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;
export type DbTransaction = Parameters<Parameters<Db['transaction']>[0]>[0];

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

/**
 * Creates the process database client. Call once at start-up (or per test file).
 *
 * Calling it again while an instance exists replaces that instance: the
 * previous pool (or test database) is closed in the background, so a second
 * call never leaks connections. Idle-client errors on the pool (the server
 * restarting, a dropped connection) are logged rather than crashing the
 * process; the pool replaces the client on the next query.
 */
export function initDb(source: DbSource): Db {
  const previous = closer;
  if (previous) {
    instance = undefined;
    closer = undefined;
    void previous().catch((err: unknown) => {
      console.error('db: closing the previous instance failed:', errorSummary(err));
    });
  }

  if ('db' in source) {
    instance = source.db;
    closer = source.close;
    return instance;
  }
  const pool = new pg.Pool({ connectionString: source.url, max: source.max });
  pool.on('error', (err) => {
    console.error('db: idle connection error:', errorSummary(err));
  });
  instance = drizzle({ client: pool, schema });
  closer = () => pool.end();
  return instance;
}

/** Message and SQLSTATE only: never the connection string or its password. */
function errorSummary(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? `${err.message} (${code})` : err.message;
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
