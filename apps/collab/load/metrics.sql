-- Live-editing load: Postgres snapshots. Run before and after a step, or in a loop
-- from the README. The write-heavy tables are pages and block_activity.

\pset pager off

-- 1. WAL position. Diff two snapshots to get WAL bytes/s for the step.
select now() as at, pg_current_wal_lsn() as wal_lsn;

-- 2. Database totals since the last stats reset.
select datname,
       xact_commit, xact_rollback,
       tup_inserted, tup_updated, tup_deleted,
       blks_read, blks_hit,
       temp_files, temp_bytes,
       deadlocks, stats_reset
from pg_stat_database
where datname = current_database();

-- 3. Connections and waits. Many rows in the same wait_event is the first clue.
select state, wait_event_type, wait_event, count(*)
from pg_stat_activity
where datname = current_database()
group by 1, 2, 3
order by 4 desc;

-- 4. Locks. granted = false is somebody waiting.
select locktype, mode, granted, count(*)
from pg_locks
group by 1, 2, 3
order by 3, 4 desc;

-- 5. Table churn. Watch n_dead_tup on pages and block_activity.
select relname, n_live_tup, n_dead_tup, last_autovacuum, last_autoanalyze
from pg_stat_user_tables
where relname in (
  'pages', 'block_activity', 'page_pending_contributors',
  'jobs', 'documents', 'versions', 'chunks'
)
order by n_dead_tup desc;

-- 6. Sizes.
select relname, pg_size_pretty(pg_total_relation_size(relid)) as total
from pg_stat_user_tables
where relname in (
  'pages', 'block_activity', 'page_pending_contributors',
  'jobs', 'documents', 'versions', 'chunks'
)
order by pg_total_relation_size(relid) desc;

-- 7. IO by backend (Postgres 16+). Writes here include the full ydoc_state rewrites.
select backend_type, object, context, reads, read_time, writes, write_time, extends, extend_time
from pg_stat_io
order by writes desc;

-- 8. Top statements. Only works when pg_stat_statements is preloaded; otherwise skip it.
-- select calls, round(total_exec_time::numeric, 1) as total_ms,
--        round(mean_exec_time::numeric, 2) as mean_ms, rows,
--        left(query, 160) as query
-- from pg_stat_statements
-- order by total_exec_time desc
-- limit 20;
