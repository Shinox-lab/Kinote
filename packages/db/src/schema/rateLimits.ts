import { pgTable, text, integer, timestamp, index } from 'drizzle-orm/pg-core';

// Global (not tenant-scoped, no RLS), like users and sessions: the counters
// behind every rate limit and budget, shared by every api and worker process.
// `key` names the limit and who it counts (e.g. `route:POST /api/v1/ask:<tenant>:<user>`);
// a row past `reset_at` is a finished window and starts again at 1.
export const rateLimitCounters = pgTable(
  'rate_limit_counters',
  {
    key: text('key').primaryKey(),
    count: integer('count').notNull(),
    resetAt: timestamp('reset_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('rate_limit_counters_reset_at_idx').on(t.resetAt)]
);
