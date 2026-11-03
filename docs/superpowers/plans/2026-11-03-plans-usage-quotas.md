# Plans, usage and quotas Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-workspace limits on seats, storage, AI credits and indexing credits, every model call metered, enforced
with warnings and grace, and set from outside through a token-protected `/internal/v1/` API.

**Architecture:** Three tenant tables (`tenant_limits`, `usage_events`, `tenant_usage`) plus `credit_topups` and a
trigger-maintained `tenant_storage`. Model providers report each call to an AsyncLocalStorage *usage scope* opened by
the api (Ask, Search) and the worker (each job); the scope flushes to the ledger and totals in one transaction when it
closes. Enforcement reads one `tenant_usage` row. The control plane talks to Kinote only through `/internal/v1/`.

**Tech Stack:** TypeScript, Fastify, Drizzle (hand-written SQL migrations), PGlite + Vitest, Postgres `test:pg`,
React 19 + TanStack Query, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-03-plans-usage-quotas-design.md`

## Global Constraints

- No `tenant_limits` row = unlimited. A self-hosted install with no new settings behaves exactly as today.
- Usage kinds are exactly `capture`, `ask`, `index`. Capture and Ask spend `credits_per_month`; `index` spends `index_credits_per_month`.
- Thresholds: warn at 80% and 100% of `L = credits_per_month + credits_topup`; refuse at `G = L × (1 + grace_percent/100)`. Index pool: hold at `index_credits_per_month × (1 + grace_percent/100)`; top-ups never add to the index pool.
- `grace_percent` default 10 (0–100). `period_anchor_day` default 1 (1–28). Periods in UTC; a period's key is its start date.
- Seats = memberships plus unexpired, unaccepted invitations, both with a role other than `viewer`. Agents never count.
- New error codes: `credits_exhausted` 429 (with `Retry-After` to period end), `seat_limit_reached` 409, `storage_limit_reached` 413.
- Refusal copy: "This workspace has used this month's AI credits. They renew on <date>." (`<date>` like "1 Dec").
- Fail open: if usage or limits cannot be read, allow the action and log the error. A ledger write failure never fails the user's action.
- Credits are stored as integer **millicredits** (`bigint`); APIs expose credits as numbers with up to 3 decimals.
- Models whose id starts with `kinote-deterministic` or `deterministic-` cost 0 unless listed by name in `MODEL_CREDIT_RATES.models`. Unset `MODEL_CREDIT_RATES` = every call 0 credits; tokens still recorded.
- `/internal/v1/` exists only when `CONTROL_PLANE_TOKENS` is set; otherwise 404. Bearer tokens compared by SHA-256 in constant time; every write audits with actor `control_plane`.
- `TENANT_DAILY_AI_ACTIONS` and the per-minute limits stay unchanged.

## Review Focus

1. **Work in flight past the grace limit** — captures accepted before the pool ran out still finish and are charged, even when that pushes usage past `G`; nothing errors. (Task 5)
2. **A downgrade below current usage** — when a PUT sets limits lower than what's already used, the very next Capture is refused, the banner shows "over", and no member is removed. (Tasks 5, 7)
3. **Period rollover** — the first action of a new period sees 0 used, top-ups from the last period do not carry over, and jobs held at the index limit run. (Tasks 3, 6)
4. **A bad `MODEL_CREDIT_RATES`** (invalid JSON, a missing file, negative numbers) — the service refuses to start and names the setting. It never silently charges 0. (Task 2)
5. **Limits removed** (`PUT` with `null`) — the workspace is unlimited at once, and held index jobs are released. (Task 8)

---

### Task 1: Schema and migration

**Files:**
- Create: `packages/db/src/schema/usage.ts`, `packages/db/migrations/0040_plans_usage.sql`, `packages/db/test/usageSchema.test.ts`
- Modify: `packages/db/src/index.ts` (export the schema), `packages/db/migrations/meta/_journal.json` (entry `idx: 40`, `tag: "0040_plans_usage"`, `when: 1794200200000`), `packages/db/test/rls.pg.test.ts` (seed one row per new table if its seeding lists tables explicitly)

**Interfaces:**
- Produces (Drizzle tables, all with `tenant_id` and RLS via `gen-rls.mjs --tables …` pasted into the same migration):
  - `tenantLimits` → `tenant_limits(tenant_id uuid PK FK tenants, seats int null, storage_bytes bigint null, credits_per_month int null, index_credits_per_month int null, grace_percent int not null default 10 CHECK 0..100, period_anchor_day int not null default 1 CHECK 1..28, updated_at timestamptz not null default now(), updated_by text not null default 'control_plane')`
  - `usageEvents` → `usage_events(id uuid PK, tenant_id, period date not null, at timestamptz not null default now(), kind text CHECK IN ('capture','ask','index'), model text, input_tokens int, output_tokens int, estimated bool not null default false, millicredits bigint not null, principal_id uuid null, document_id uuid null)`, index `(tenant_id, at)`
  - `tenantUsage` → `tenant_usage(tenant_id, period date, credits_used_milli bigint default 0, index_credits_used_milli bigint default 0, credits_topup int default 0, warned_80_at timestamptz null, warned_100_at timestamptz null, PK(tenant_id, period))`
  - `creditTopups` → `credit_topups(id uuid PK, tenant_id, period date, credits int CHECK > 0, idempotency_key text, created_at, UNIQUE(tenant_id, idempotency_key))`
  - `tenantStorage` → `tenant_storage(tenant_id PK, bytes bigint not null default 0)`
- SQL in the migration, beyond tables and RLS:
  - Trigger `versions_storage_count` AFTER INSERT OR DELETE ON `versions`, FOR EACH ROW, only where `size_bytes IS NOT NULL`. It upserts `tenant_storage.bytes += / -= size_bytes`.
  - A one-time backfill: `INSERT INTO tenant_storage SELECT tenant_id, sum(size_bytes) … GROUP BY tenant_id`. Run it **before** the RLS statements for `tenant_storage`: FORCE RLS applies to the migration owner too.
  - `SECURITY DEFINER` functions, written like `my_tenants` (pinned `search_path`, schema-qualified names, `REVOKE ALL FROM PUBLIC`, `GRANT EXECUTE TO kinote_app`):
    - `cp_list_tenants(p_after uuid, p_limit int)` returns `(id, slug, name, plan, created_at, deleted_at, owner_email, seats)`, ordered by `(created_at, id)` and starting after `p_after`.
    - `cp_usage_totals(p_period date, p_after uuid, p_limit int)` returns `(tenant_id, period, credits_used_milli, index_credits_used_milli, credits_topup, storage_bytes)`.

- [ ] **Step 1: Write failing tests** in `usageSchema.test.ts` (PGlite, `createTestDb`):
  - `the new tables exist with RLS forced`: `pg_class.relforcerowsecurity` is true for all five tables.
  - `storing a file version counts its bytes; deleting it uncounts them`: insert a tenant and a version with `size_bytes = 1000` in `withTenantTx`, expect `tenant_storage.bytes = 1000`, delete it, expect `0`.
  - `a page version (size_bytes null) leaves storage alone`.
  - `cp_list_tenants works as kinote_app with no tenant set`: two tenants, `limit 1` then `after=<first>`, returns them in order.
- [ ] **Step 2: Run** `pnpm vitest run packages/db/test/usageSchema.test.ts`. Expected: FAIL (relation does not exist).
- [ ] **Step 3: Write** the schema file, the migration and the journal entry. The minimum columns needed for the version insert in the test are in `packages/db/src/schema/pages_and_index.ts`.
- [ ] **Step 4: Run** the test again, then `pnpm vitest run packages/db`. Expected: PASS, with no other db test broken.
- [ ] **Step 5: Commit** `feat(db): tables for limits, usage ledger, top-ups and storage`.

---

### Task 2: Settings and credit rates

**Files:**
- Create: `packages/shared/src/creditRates.ts`, `packages/shared/test/creditRates.test.ts` (or next to existing shared tests)
- Modify: `packages/shared/src/config.ts`, `packages/shared/src/index.ts`, `.env.example`, `docs/operations.md`

**Interfaces:**
- Produces:
  - `type CreditRate = { input: number; output: number }`, credits per 1,000 tokens, each ≥ 0.
  - `type CreditRates = { default: CreditRate; models: Record<string, CreditRate> }`
  - `parseCreditRates(raw: string | undefined, readFile?: (p: string) => string): CreditRates | null`. `undefined` returns null. A value starting with `{` is JSON; anything else is a file path. It throws `Error('MODEL_CREDIT_RATES: <reason>')` on bad JSON, a missing file, or a schema failure.
  - `millicreditsFor(rates: CreditRates | null, model: string, inputTokens: number, outputTokens: number): number`. Returns an integer, rounded up, so any nonzero usage costs at least 1 millicredit. It returns 0 when `rates` is null, and 0 for deterministic ids (see Global Constraints) unless they're listed. For an unlisted model it uses `default` and calls `onUnlistedModel(model)` once per process.
  - `Config` gains `MODEL_CREDIT_RATES?: string`, `CONTROL_PLANE_TOKENS?: string[]` (comma-split, trimmed, empties dropped, each at least 32 characters) and `BILLING_URL?: string` (a URL). `loadConfig` calls `parseCreditRates` so bad rates fail at startup.

- [ ] **Step 1: Write failing tests**:
  - `rates from inline JSON and from a file are the same`
  - `{"default":{"input":1,"output":4},"models":{"m":{"input":2,"output":8}}}`: 1,500 input tokens and 500 output tokens on model `m` cost `5000` millicredits. On an unlisted model `x` they cost `3500`, and the unlisted-model warning fires once across two calls.
  - `deterministic models are free unless listed`: `kinote-deterministic-2560-v1` costs `0`. Listing it under `models` charges it.
  - `null rates charge nothing`.
  - `bad settings refuse to start`: `loadConfig` with `MODEL_CREDIT_RATES='{oops'`, with `'/nope.json'`, and with `{"default":{"input":-1,"output":0}}` each throws a message containing `MODEL_CREDIT_RATES`.
  - `CONTROL_PLANE_TOKENS splits and rejects short tokens`.
- [ ] **Step 2: Run** `pnpm vitest run packages/shared`. Expected: FAIL.
- [ ] **Step 3: Implement** `creditRates.ts` with a Zod schema, then the three config keys. Document all three in `.env.example` and in a "Plans and usage" section of `docs/operations.md`. That section also says `/internal/` must not be exposed through the public proxy, and that `TENANT_DAILY_AI_ACTIONS` is a safety net, not billing.
- [ ] **Step 4: Run** the tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat(shared): MODEL_CREDIT_RATES, CONTROL_PLANE_TOKENS and BILLING_URL settings`.

---

### Task 3: Periods, ledger, totals and top-ups (db layer)

**Files:**
- Create: `packages/db/src/usage.ts`, `packages/db/test/usage.test.ts`
- Modify: `packages/db/src/index.ts`

**Interfaces:**
- Consumes: the Task 1 tables.
- Produces:
  - `type UsageKind = 'capture' | 'ask' | 'index'`
  - `periodOf(anchorDay: number, now: Date): { key: string; start: Date; end: Date }`. `key` is `YYYY-MM-DD` (the start date) and `end` is exclusive.
  - `type TenantLimits = { seats: number|null; storageBytes: number|null; creditsPerMonth: number|null; indexCreditsPerMonth: number|null; gracePercent: number; periodAnchorDay: number }`
  - `type UsageStanding = { limits: TenantLimits | null; period: { key: string; start: Date; end: Date }; creditsUsedMilli: number; indexCreditsUsedMilli: number; creditsTopup: number; storageBytes: number; warned80At: Date|null; warned100At: Date|null }`
  - `readStanding(tx: DbTransaction, tenantId: string, now: Date): Promise<UsageStanding>`. With no limits row it uses anchor day 1.
  - `recordUsage(tx, tenantId: string, events: Array<{ kind: UsageKind; model: string; inputTokens: number; outputTokens: number; estimated: boolean; millicredits: number; principalId?: string|null; documentId?: string|null }>, now: Date): Promise<UsageStanding>`. It inserts the ledger rows, upserts `tenant_usage` by adding the sums to the right column, and returns the standing after the change.
  - `markWarned(tx, tenantId, periodKey: string, level: 80 | 100, now: Date): Promise<boolean>`. A conditional update (`… WHERE warned_<level>_at IS NULL`); it returns true only for the first caller.
  - `addTopup(tx, tenantId, credits: number, idempotencyKey: string, now: Date): Promise<{ created: boolean; periodKey: string; creditsTopup: number }>`
  - `releaseHeldIndexJobs(tx, tenantId: string, now: Date): Promise<number>`. Sets `run_at = now` on `queued` jobs in `INDEX_QUEUES` whose `run_at > now`.
  - `INDEX_QUEUES = ['version.index', 'document.reindex', 'version.card', 'version.entities'] as const`

- [ ] **Step 1: Write failing tests** (PGlite):
  - `periodOf`: for anchor 1 and now `2026-11-03T10:00Z`, the key is `2026-11-01` and the end is `2026-12-01T00:00Z`. Anchor 15 on `2026-11-03` gives key `2026-10-15`. Anchor 28 on `2027-02-28T00:00Z` gives key `2027-02-28`. Anchor 28 on `2026-12-31` gives key `2026-12-28` and end `2027-01-28`.
  - `recordUsage adds capture and ask to credits and index to index credits`.
  - `a new period starts at zero and leaves last period's top-ups behind` (record and top up in October, then read with a November `now`).
  - `markWarned is true once per level per period`.
  - `addTopup with a repeated key adds nothing and reports created=false`.
  - `releaseHeldIndexJobs moves only future-dated index jobs` (an index job a day ahead becomes due; a future `capture.route` job and an index job that's already due stay as they are).
- [ ] **Step 2: Run** `pnpm vitest run packages/db/test/usage.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `usage.ts`.
- [ ] **Step 4: Run** it. Expected: PASS.
- [ ] **Step 5: Commit** `feat(db): usage ledger, period totals, top-ups and held-job release`.

---

### Task 4: Metering model calls

**Files:**
- Create: `packages/core/src/usage/meter.ts`, `packages/core/test/meter.test.ts` (follow core's existing test location)
- Modify:
  - `packages/core/src/llm/chatJson.ts`: call `reportModelCall` after `usageOf`, next to `opts.onUsage`.
  - `packages/core/src/embedding.ts`: both providers report. OpenAI reads `usage.prompt_tokens`, falling back to an estimate. Deterministic reports estimated tokens under its `model`.
  - `packages/core/src/answer.ts`: OpenAI reads `usage`. Deterministic reports estimated tokens as `deterministic-answer-v1`.
  - `packages/core/src/placement/model.ts`: the deterministic model reports estimated tokens under `deterministic-placement-v1`. The OpenAI one already reports through `chatJson`.
  - `packages/core/src/index.ts`
  - `apps/worker/src/runner.ts`: `RunnerOptions.creditRates?: CreditRates | null`, and `runOne` wraps `handler.run` in a scope.
  - `apps/worker/src/main.ts`: pass `config.MODEL_CREDIT_RATES` parsed rates.
  - `apps/api/src/server.ts`: `ApiServerOptions.creditRates?`. Ask runs in scope `ask`, Search in scope `index`.
  - `apps/api/src/main.ts`: pass the rates.

**Interfaces:**
- Consumes: `recordUsage` and `markWarned` (Task 3), `millicreditsFor` (Task 2), `notify` (`packages/core/src/talk/notify.ts`).
- Produces:
  - `type UsageScope = { tenantId: string; kind: UsageKind; principalId?: string|null; documentId?: string|null }`
  - `withUsageScope<T>(scope: UsageScope, rates: CreditRates | null, fn: () => Promise<T>): Promise<T>`. Calls made while `fn` runs are buffered. When `fn` settles, successfully or not, they're flushed in one `withTenantTx`: `recordUsage`, then warnings. Flush errors are logged, never thrown. A call reported with no scope open is logged once and dropped.
  - `reportModelCall(call: { model: string; inputTokens: number; outputTokens: number; estimated: boolean }): void`
  - `estimateTokens(text: string): number`, which is `Math.ceil(text.length / 4)`.
  - Warnings, in the flush transaction: once `credits_used_milli` reaches 80% (then 100%) of `L × 1000` and `markWarned` returns true, `notify` every owner and admin with kind `credits_warning`, `actorType: 'connector'`, `actorId: tenantId`, `excerpt: '80'` or `'100'`. Add `credits_warning` to `NOTIFICATION_KINDS` (`packages/db/src/schema/talk.ts`) and `NotificationKindSchema` (`packages/contracts/src/index.ts`). In `apps/web/src/lib/notifications.ts`, the headline is "This workspace has used 80% of this month's AI credits" or "This workspace has used all of this month's AI credits", and the target is `/w/<slug>/admin/usage`. Check that `listNotifications` resolves a `connector` actor whose id isn't a source, and fall back to the name "Kinote".
  - Worker scope kind by queue: `capture.route` and `capture.place` are `capture`; everything else is `index`. `principalId` and `documentId` come from the job payload when present.

- [ ] **Step 1: Write failing tests**:
  - `calls inside a scope land in the ledger with credits`: rates `{default:{input:1,output:1}, models:{}}`, then `withUsageScope({tenantId, kind:'ask'}, rates, async () => reportModelCall({model:'m', inputTokens:1000, outputTokens:0, estimated:false}))`. Expect one `usage_events` row with `millicredits = 1000` and `tenant_usage.credits_used_milli = 1000`.
  - `a scope whose work throws still records what was spent, and rethrows`.
  - `a ledger failure does not fail the work`: make `recordUsage` throw (inject it through a test seam or a dropped table) and expect `fn`'s result to come back.
  - `crossing 80% notifies owners and admins once`: limits `credits_per_month = 10`. Report 8,000 millicredits, then 500 more. Expect exactly one `credits_warning` notification each for the owner and the admin and none for a member, with `excerpt = '80'`.
  - In `apps/api/test/usageMetering.test.ts`: `Ask records an ask event`, `Search records an index event`. With a worker run (`runPendingJobsForTenant` with `creditRates`): `a capture.route job records capture events` and `version.index records index events`. Use deterministic providers with rates listing their model ids.
- [ ] **Step 2: Run** `pnpm vitest run packages/core/test/meter.test.ts apps/api/test/usageMetering.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `meter.ts` with `AsyncLocalStorage`, add the provider reporting, and wire the scopes into the api and worker.
- [ ] **Step 4: Run** those tests, then `pnpm test`. Expected: PASS, no regressions. The existing `onUsage` routing eval still works.
- [ ] **Step 5: Commit** `feat: meter every model call into the usage ledger`.

---

### Task 5: Credit enforcement in the API

**Files:**
- Create: `packages/core/src/usage/standing.ts` (pure), `packages/core/test/standing.test.ts`, `apps/api/test/credits.test.ts`
- Modify: `packages/contracts/src/errors.ts` (codes, sentences, statuses), `apps/api/src/usageLimits.ts`, `apps/api/src/server.ts`

**Interfaces:**
- Consumes: `readStanding` (Task 3).
- Produces:
  - `type CreditState = 'unlimited' | 'ok' | 'warn' | 'over' | 'exhausted'`
  - `creditVerdict(s: UsageStanding): { state: CreditState; usedCredits: number; limitCredits: number | null; graceLeftCredits: number | null; resetsAt: Date }`. Credit amounts are in credits, not milli. `warn` means at least 80% and under 100% of L. `over` means at least 100% of L and under G. `exhausted` means at least G.
  - `indexHeld(s: UsageStanding): boolean`
  - `requireCredits(billingUrl?: string)`, which returns an `onRequest` hook, in `usageLimits.ts`. It reads the standing in a tenant tx (fail open). When the state is `exhausted` it throws `AppError('credits_exhausted')` with header `retry-after` set to the seconds until `resetsAt`. The body adds `resetsAt` (ISO) and `billingUrl` when `BILLING_URL` is set: extend the error reply for this code only. The message reads "This workspace has used this month's AI credits. They renew on 1 Dec." with the date formatted `d MMM` in UTC.
  - `ApiServerOptions.billingUrl?: string`.
  - Apply `requireCredits` to: `POST /api/v1/captures`, `/ask`, `/capture-changes/:id/move`, `/capture-facts/:id/place`, `/captures/:id/document/place`, `/captures/:id/document/as-updates`, `/captures/:id/document/move`. Keep the existing `TENANT_DAILY_AI_ACTIONS` checks alongside.

- [ ] **Step 1: Write failing tests**:
  - `standing.test.ts`: with `credits_per_month = 100`, grace 10 and top-up 0, used 79 is `ok`, 80 is `warn`, 100 is `over`, 109.999 is `over` with `graceLeftCredits` ≈ 0.001, and 110 is `exhausted`. A top-up of 50 turns used 110 into `warn`. With no limits the state is `unlimited`. `indexHeld` is true at `index_credits_per_month × 1.1`.
  - `credits.test.ts`:
    - `a workspace past grace cannot capture or ask, and is told when credits renew`: insert limits and usage directly. Expect 429 `credits_exhausted`, a message ending `They renew on 1 Dec.` (with `now` mocked in November), a `retry-after` header of at least 1, and `resetsAt` present.
    - `billingUrl is in the refusal only when configured`.
    - `inside grace the capture is accepted`.
    - `a limit lowered below usage refuses the next capture`. This is Review Focus 2: PUT-equivalent db update, then the capture is refused.
    - `work already queued finishes and is charged past the limit`. This is Review Focus 1: queue two captures under the limit, exhaust the pool, run the worker, expect both routed and `credits_used_milli` above `G`.
    - `an unreadable standing lets the capture through`. Drop or rename `tenant_usage` within the test, or inject a failing reader.
- [ ] **Step 2: Run** `pnpm vitest run packages/core/test/standing.test.ts apps/api/test/credits.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** it.
- [ ] **Step 4: Run** them, plus `apps/api/test/usageLimits.test.ts` and `apps/api/test/errors.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): refuse AI actions past the credit grace limit`.

---

### Task 6: Holding indexing at the index limit

**Files:**
- Create: `apps/worker/test/indexHold.test.ts` (or the worker's existing test folder)
- Modify: `apps/worker/src/runner.ts`, `apps/api/src/pages/badge.ts` and its callers (pass `indexingPaused: boolean`), plus the badge test

**Interfaces:**
- Consumes: `readStanding`, `INDEX_QUEUES` (Task 3), `indexHeld` (Task 5).
- Produces:
  - In `runOne`, before a job in `INDEX_QUEUES` runs, it reads the standing (fail open). If `indexHeld`, it re-enqueues the job with `runAt = period.end` (the same `enqueueJob` pattern as `deferredPastAllowance`), logs it, and returns without running it.
  - Badge: when the latest version would be indexed next (approved, or review not needed) and `indexingPaused` is true, it reads `Saved · not indexed (indexing limit reached)`. `indexingPaused` comes from `indexHeld(readStanding(…))` wherever the badge input is built.

- [ ] **Step 1: Write failing tests**:
  - `an index job waits until the period ends once the index pool is used up`: set limits `index_credits_per_month = 1` and usage `index_credits_used_milli = 1100`, enqueue `version.index`, run. Expect the job queued with `run_at` = the period end and no chunks written.
  - `raising the limit releases it`: after the hold, update limits and call `releaseHeldIndexJobs`, run again, and expect the version indexed.
  - `a new period releases it`: run with a clock in the next period and expect it indexed. This is Review Focus 3.
  - `capture jobs are never held by the index pool`.
  - Badge test: `paused indexing shows the limit reason`.
- [ ] **Step 2: Run** the new tests. Expected: FAIL.
- [ ] **Step 3: Implement** it.
- [ ] **Step 4: Run** them, plus `pnpm vitest run apps/worker apps/api/test/pageDetails.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(worker): hold indexing at the index credit limit`.

---

### Task 7: Seat and storage limits

**Files:**
- Create: `packages/core/src/usage/capacity.ts`, `apps/api/test/seatsStorage.test.ts`
- Modify:
  - `apps/api/src/routes/foundations.ts`: `inviteMember`, `acceptInvitation`, `signUpWithInvitation`
  - `apps/api/src/routes/admin.ts`: `changeMemberRole`
  - `apps/api/src/routes/files.ts`: `uploadFile`, and the new-version upload behind `POST /api/v1/files/:id/versions`
  - `apps/api/src/routes/sourceFiles.ts`: `putSourceFile`
  - `packages/contracts/src/errors.ts`

**Interfaces:**
- Produces:
  - `countSeats(tx, tenantId: string, now: Date, o?: { excludeInvitationId?: string }): Promise<number>`, counted as in Global Constraints.
  - `assertSeatFor(tx, tenantId, role: TenantRole, now, o?)`. It does nothing for `viewer`, or with no seat limit. It throws `seat_limit_reached` when `countSeats + 1 > seats`. On accept, pass `excludeInvitationId` so the invitation being accepted isn't counted twice. On a role change from viewer to another role, count +1. A change between non-viewer roles is +0 and never refused.
  - `assertStorageFor(tx, tenantId, addBytes: number)`. It throws `storage_limit_reached` when `tenant_storage.bytes + addBytes > storage_bytes`.
  - All the checks run inside the transaction that writes the row, so concurrent writes are serialised by it, and they fail open on read errors.
  - Error sentences: `seat_limit_reached`: "This workspace has no free seats on its plan. Remove someone or upgrade to add more." `storage_limit_reached`: "This file would take the workspace over its storage limit."

- [ ] **Step 1: Write failing tests**:
  - `seats count members and pending invitations but not viewers or agents`
  - `inviting past the seat limit is refused; inviting a viewer is not`
  - `accepting your own pending invitation at a full workspace succeeds`
  - `promoting a viewer at a full workspace is refused; member→admin is not`
  - `after a downgrade nobody is removed and nobody can be added`
  - `an upload past the storage limit is refused with 413 and nothing is stored`
  - `a new file version past the limit is refused`, and the same for a source PUT
  - `with no limits, nothing is refused`
- [ ] **Step 2: Run** `pnpm vitest run apps/api/test/seatsStorage.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** it.
- [ ] **Step 4: Run** it, plus `apps/api/test/invitations.test.ts apps/api/test/admin.test.ts apps/api/test/filesUpload.test.ts apps/api/test/sourcePut.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): seat and storage limits`.

---

### Task 8: Control-plane API

**Files:**
- Create: `packages/contracts/src/internal.ts`, `apps/api/src/routes/internal.ts`, `apps/api/test/internalApi.test.ts`, `docs/control-plane-api.md`
- Modify: `packages/contracts/src/index.ts`, `apps/api/src/server.ts` (register it when `controlPlaneTokens` is non-empty), `apps/api/src/main.ts`, `packages/db/test/rls.pg.test.ts` (add a check that `cp_*` works as `kinote_app` and returns rows across tenants)

**Interfaces:**
- Consumes: `cp_list_tenants`, `cp_usage_totals` (Task 1); `readStanding`, `addTopup`, `releaseHeldIndexJobs` (Task 3); `creditVerdict` (Task 5); `writeAuditEvent`.
- Produces:
  - `ApiServerOptions.controlPlaneTokens?: string[]`
  - The routes use `config: { auth: 'public' }` plus their own `onRequest` bearer check: SHA-256 each configured token once at startup, then `timingSafeEqual` against the hash of the presented token. A missing or wrong token gets 401 `unauthorized`.
  - Zod schemas in `internal.ts`, with camelCase field names:
    - `LimitsInputSchema = { plan: string(1..40), seats, storageBytes, creditsPerMonth, indexCreditsPerMonth: int ≥ 0 | null; gracePercent?: 0..100; periodAnchorDay?: 1..28 }`. The PUT body is `LimitsInputSchema | null`.
    - `TenantUsageSchema = { period, periodEnd, creditsUsed, indexCreditsUsed, creditsTopup, storageBytes, seats, state: CreditState, indexHeld }`
    - `InternalTenantSchema = { id, slug, name, plan, createdAt, deletedAt, ownerEmail, seats }`
    - `InternalTenantDetailSchema = InternalTenantSchema & { limits: TenantLimits | null; usage: TenantUsageSchema }`
    - `TopupInputSchema = { credits: int > 0, idempotencyKey: string(1..200) }`
    - Responses: `InfoSchema = { kinoteVersion, apiVersion: 1, features: string[] }` (features: `['limits','usage','topups']`); `TenantPageSchema = { tenants, next: string|null }`; `UsagePageSchema = { usage: Array<TenantUsageSchema & { tenantId }>, next }`
  - Routes:
    - `GET /internal/v1/info`
    - `GET /internal/v1/tenants?after=&limit=` (limit default 100, max 500)
    - `GET /internal/v1/tenants/:id`: 404 `tenant_not_found` when it's unknown. A deleted tenant is returned with `deletedAt` set.
    - `PUT /internal/v1/tenants/:id/limits`: 404 for unknown or deleted tenants. It upserts or deletes `tenant_limits`, sets `tenants.plan` (to `'standard'` when the body is `null`), calls `releaseHeldIndexJobs` every time, writes an audit event (`limits.updated`, actor `control_plane`), and returns `InternalTenantDetailSchema`.
    - `POST /internal/v1/tenants/:id/topups`: returns 201 when created and 200 on a repeated key, with the same body either way. Audit `credits.topup`.
    - `GET /internal/v1/usage?period=YYYY-MM-DD&after=&limit=`. Without `period`, each tenant's current period is used.
  - The usage numbers in `/tenants/:id` and `/usage` are computed the same way.
  - Note for sub-project 2: the spec's `updatedSince` filter is replaced by keyset paging on `(created_at, id)`. New tenants come last, so the control plane picks up sign-ups by paging from the last id it saw.

- [ ] **Step 1: Write failing tests** in `internalApi.test.ts`:
  - `without CONTROL_PLANE_TOKENS the internal API does not exist` (404)
  - `no token or a wrong token is 401; either of two rotated tokens works`
  - `info answers apiVersion 1`
  - `tenants page in creation order and continue after the last id`
  - `PUT limits stores them, sets the plan label, audits, and the next capture is refused when usage is past them`
  - `PUT null removes limits: the workspace is unlimited again and held index jobs are released` (Review Focus 5)
  - `topup is idempotent by key and lifts a refused workspace back to accepted`
  - `PUT limits on an unknown tenant is 404 tenant_not_found`
  - `every response parses with its schema`
- [ ] **Step 2: Run** `pnpm vitest run apps/api/test/internalApi.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the routes and schemas. Write `docs/control-plane-api.md`: authentication, every endpoint with request and response examples, the error codes, the additive-only rule within `v1`, and the keyset paging note.
- [ ] **Step 4: Run** the tests, then `pnpm typecheck`. Expected: PASS. If Docker is available, also run `pnpm test:pg` (it covers RLS on the new tables and `cp_*` as the app role). If it isn't, record that it wasn't run.
- [ ] **Step 5: Commit** `feat(api): control-plane API for limits, top-ups and usage`.

---

### Task 9: Usage page, banner and end-to-end

**Files:**
- Create: `apps/web/src/routes/admin/usage.tsx`, `apps/web/src/components/UsageBanner.tsx`, `apps/web/src/lib/usage.ts`, `apps/web/test/usage.test.ts`, `e2e/usage.spec.ts`
- Modify:
  - `packages/contracts/src/index.ts`: `UsageSummarySchema`
  - `apps/api/src/server.ts`: `GET /api/v1/usage`
  - `apps/web/src/router.tsx`: route `admin/usage`
  - `apps/web/src/routes/admin/layout.tsx`: a "Usage" screen in the settings nav, for owners and admins
  - `apps/web/src/routes/layout.tsx`: render `<UsageBanner />` at the top of the console
  - `e2e/harness/local-stack.ts`: pass `creditRates`, `controlPlaneTokens` and `billingUrl` from config. Default `CONTROL_PLANE_TOKENS` to an e2e token, and `MODEL_CREDIT_RATES` to rates listing the deterministic model ids at `{input:1000, output:1000}`, so one capture uses whole credits.
  - `docs/kinote-standalone-design.md`: a Progress row "Plans, usage and quotas" pointing to the spec and this plan

**Interfaces:**
- Consumes: `creditVerdict`, `indexHeld`, `readStanding`, `countSeats`.
- Produces:
  - `GET /api/v1/usage`, for any workspace member. It returns `UsageSummarySchema = { state: CreditState; plan: string; usedCredits; limitCredits|null; creditsTopup; graceLeftCredits|null; indexUsedCredits; indexLimitCredits|null; indexHeld: boolean; storageBytes; storageLimitBytes|null; seats; seatLimit|null; resetsAt; billingUrl: string|null }`. `billingUrl` is null unless the caller is an owner or admin and `BILLING_URL` is set.
  - `bannerText(u: UsageSummary): string | null` in `apps/web/src/lib/usage.ts`:
    - `warn`: "This workspace has used 80% of this month's AI credits."
    - `over`: "Over this month's AI credits: N left before AI actions pause." (N rounded down to a whole credit)
    - `exhausted`: "This workspace has used this month's AI credits. They renew on 1 Dec."
    - `ok` or `unlimited`: null.
  - The banner adds an "Upgrade" link when `billingUrl` is present. The Usage page shows credits, index credits, storage and seats as "used of limit" (or just "used" when there's no limit), plus the plan label and "Renews on <date>".

- [ ] **Step 1: Write failing tests**:
  - `apps/web/test/usage.test.ts`: `bannerText` for each state, including N rounding and the date format.
  - `apps/api/test/credits.test.ts`, extended:
    - `GET /usage gives members the state but no billing link`
    - `owners get the billing link`
  - `e2e/usage.spec.ts`, which uses `seedWorld` and then sets limits through `/internal/v1` with the e2e token:
    - `the console warns at 80%, counts down in grace, and refuses past it`. Use `creditsPerMonth` sized to the deterministic per-capture cost, measured once in the test through `GET /api/v1/usage`. Expect each banner text in turn, then a capture refused with the renewal sentence.
    - `the Usage page shows plan, credits, storage and seats`
    - `a page waits with "indexing limit reached" and is indexed after the limit is raised`
- [ ] **Step 2: Run** `pnpm vitest run apps/web/test/usage.test.ts apps/api/test/credits.test.ts`, then `E2E_MODE=local pnpm exec playwright test e2e/usage.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** it.
- [ ] **Step 4: Run** the same commands, then `pnpm test`, `pnpm typecheck` and `pnpm web:build`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): usage page and credit banner`.
