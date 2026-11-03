# Plans, usage and quotas — design

Status: draft, 2026-11-03. The first sub-project of hosted Kinote. Builds on `docs/kinote-standalone-design.md`
(slice 7 "Hardening": quotas and usage, `tenant_usage`). Where they differ, this wins for limits, usage and the
control-plane API.

## Why

Hosted Kinote is "coming soon" on the site. To open it to the public with self-serve sign-up and paid plans, Kinote
must be able to hold each workspace to its plan: how many people, how much storage, and above all how much AI it uses,
because on the hosted service every embedding and model call is paid for by us. Kinote is MIT and self-hostable, so it
must do this without knowing anything about our plans, prices or payment provider, and a self-hosted install must
behave exactly as it does today.

## The hosted platform, and where this fits

Owner's decisions (2026-11-03):

- Hosted Kinote runs **both** ways: one shared multi-tenant deployment, and dedicated per-customer instances later.
- First goal: **open the shared deployment to the public** with self-serve sign-up and paid plans.
- Pricing: **tiers with included limits** (e.g. Free, Team, Business).
- AI usage is shown to customers as **credits**, converted from real tokens by model price.
- At the credit limit, **actions people start stop; indexing keeps going** under its own cap. Warnings at 80% and 100%,
  with a grace buffer before anything stops.
- **Kinote enforces numbers; Kinote-SaaS owns plans** (option 1 of three considered; see "Approaches considered").

Sub-projects, each with its own spec, plan and build:

| # | Sub-project | Repo | Order |
|---|---|---|---|
| 1 | Plans, usage and quotas (this spec) | Kinote | First |
| 2 | Control plane core: customers, subscriptions, which deployment each runs on | Kinote-SaaS (private) | Second |
| 3 | Billing: payment provider, checkout, invoices, plan changes, suspension for non-payment | Kinote-SaaS | Third |
| 6 | Public sign-up: "Try Kinote" → sign up → choose plan → running workspace | Kinote-SaaS (+ tenant creation in Kinote's internal API) | Fourth |
| 4 | Operator console for the shared deployment | Kinote-SaaS | Later |
| 5 | Dedicated-instance provisioning, upgrades, backups | Kinote-SaaS | Later |

The line between the repos: anything every install needs (limits, metering, enforcement, the internal API) is in
Kinote. Anything only the hosted business needs (plan catalog, prices, payments, provisioning, operator tools) is in
Kinote-SaaS. The control plane talks to every Kinote deployment, shared or dedicated, through the same internal API.

## Goals

1. **Per-workspace limits** on seats, storage, AI credits and indexing credits, set from outside Kinote.
2. **Every model call metered** in tokens and credits, attributed to a workspace and a kind of work.
3. **Clear, never silent, enforcement:** warnings at 80% and 100%, a grace buffer, then a refusal that says why and when
   it renews. Search never quietly goes stale.
4. **A stable internal API** for the control plane to set limits, add top-ups and read usage.
5. **Self-hosters unaffected:** no limits configured means no limits, and usage is still visible to them.

Success, as one story: a workspace on a small plan runs Capture until an admin gets an in-app warning at 80% and again
at 100%. Captures keep working inside the grace buffer, then Capture says "This workspace has used this month's AI
credits. They renew on 1 Dec." with an Upgrade link. Search keeps finding newly approved pages throughout. The control
plane adds a top-up and Capture works again at once. A self-hosted install with nothing configured sees none of this.

## Non-goals

- Plan names, prices, payment providers, invoices (Kinote-SaaS, sub-projects 2–3).
- Creating or suspending tenants from the control plane (sub-projects 6 and 3; added to `v1` later, additively).
- Email warnings (Kinote-SaaS can send them from the usage API).
- A customer-facing "where did my credits go" breakdown. The ledger supports it; the screen comes later.
- Reserving credits before work starts. Overshoot is bounded by work in flight and absorbed by grace.

## Approaches considered

1. **Kinote enforces numbers; Kinote-SaaS owns plans (chosen).** Kinote stores per-tenant numbers and knows nothing of
   "Team". Custom deals and top-ups are just different numbers. Same API for shared and dedicated deployments.
2. **Plan catalog in Kinote config.** The control plane sets only `tenants.plan`. Rejected: plan changes need a Kinote
   redeploy, custom deals need new plans, and commercial plans would be published in the public repo.
3. **Kinote asks Kinote-SaaS before every AI call.** Rejected: a network call in every capture, and a control-plane
   outage takes every Kinote deployment down with it.

## What exists today

- `TENANT_DAILY_AI_ACTIONS` (default 2000): one per-deployment daily cap on AI actions per workspace, counted in
  `packages/db/src/rateLimits.ts` and answered with `ai_budget_exhausted`. **Kept** as a safety net against runaway
  loops; its docs are updated to say it is not billing.
- Per-minute request limits (`requestLimit` in `apps/api/src/usageLimits.ts`). **Kept** unchanged; they protect load.
- `chatJson` reports token usage through `onUsage` (`packages/core/src/llm/chatJson.ts`), used only by the routing eval.
  Embedding calls report nothing yet.
- `tenants.plan` (text, default `'standard'`). Becomes a display label the control plane sets.

## Data model

All three tables are tenant-scoped with row-level security, like every other tenant table.

**`tenant_limits`** — at most one row per tenant. No row means unlimited.

| Column | Type | Meaning |
|---|---|---|
| `tenant_id` | uuid PK, FK tenants | |
| `seats` | int, null | Members with a role other than viewer. Null = unlimited. |
| `storage_bytes` | bigint, null | Total stored file bytes. Null = unlimited. |
| `credits_per_month` | int, null | Pool for Capture and Ask. Null = unlimited. |
| `index_credits_per_month` | int, null | Separate pool for indexing work. Null = unlimited. |
| `grace_percent` | int, default 10 | Allowed overrun past 100% before actions stop. 0–100. |
| `period_anchor_day` | int, default 1 | Day of month (1–28) the period starts, UTC. |
| `updated_at` | timestamptz | |
| `updated_by` | text | `control_plane` (only writer in v1). |

**`usage_events`** — the ledger. Append-only, one row per model call.

| Column | Type | Meaning |
|---|---|---|
| `id` | uuid PK | |
| `tenant_id` | uuid | |
| `at` | timestamptz | |
| `kind` | enum `capture`, `ask`, `index` | Which pool it is charged to (see "What counts as what"). |
| `model` | text | Model id as configured. |
| `input_tokens`, `output_tokens` | int | |
| `estimated` | bool | True when the provider returned no usage and tokens were estimated. |
| `credits` | numeric(12,3) | Calculated at insert from `MODEL_CREDIT_RATES`. |
| `principal_id` | uuid, null | Who started it, when a person or agent did. |
| `document_id` | uuid, null | The document involved, when there is one. |

Indexed on `(tenant_id, at)`.

**`tenant_usage`** — running totals per tenant per period, so a check reads one row.

| Column | Type | Meaning |
|---|---|---|
| `tenant_id`, `period` | PK; `period` is the period's start date | |
| `credits_used` | numeric | Sum of `capture` and `ask` credits. |
| `index_credits_used` | numeric | Sum of `index` credits. |
| `credits_topup` | int, default 0 | Extra credits added to this period only. |
| `warned_80_at`, `warned_100_at` | timestamptz, null | Each warning is sent once per period. |

The totals are updated in the same transaction as each ledger insert. Top-ups are recorded in **`credit_topups`**
(`tenant_id`, `period`, `credits`, `idempotency_key` unique per tenant, `created_at`), and `credits_topup` is their sum.

**Storage** is counted live as the sum of stored file version sizes, maintained as a per-tenant counter
(`tenant_storage.bytes`) updated when a file version is stored or purged. **Seats** are counted live from
`memberships` (role other than viewer). Agents and viewers never count.

**Periods** are computed in UTC from `period_anchor_day`. A tenant without limits uses day 1. Because the anchor is
1–28, every month has the date.

## What counts as what

| Work | Kind | Pool |
|---|---|---|
| Capture routing, from the console or MCP | `capture` | credits |
| Ask answers | `ask` | credits |
| Embeddings, page cards, entity extraction, placement, re-indexing after approval | `index` | index credits |

Docling extraction runs locally and makes no model call, so it is not metered. An external agent's own model calls are
not ours. Deterministic and fake models (development, tests) cost 0 credits.

## Metering

- `onUsage` is wired for every Capture, Ask and indexing call, tagged with tenant, kind, principal and document.
- The embedding provider reads `usage.prompt_tokens` from OpenAI-compatible responses. When a provider omits usage,
  tokens are estimated at 4 characters per token and the row has `estimated = true`.
- **`MODEL_CREDIT_RATES`** (inline JSON or a file path) maps model id → credits per 1,000 input tokens and per 1,000
  output tokens, plus a `default` entry. A model not listed is charged at `default` and logs a warning once per process,
  so a missing entry is never free. If `MODEL_CREDIT_RATES` is unset, every call costs 0 credits; tokens are still
  recorded.
- A failure to write the ledger is logged and does not fail the user's action.

## Enforcement

**Limits** used below: `L = credits_per_month + credits_topup`; grace limit `G = L × (1 + grace_percent / 100)`.

**Capture, Ask, MCP capture** — the API checks `tenant_usage` before accepting the request:

| Used | Behaviour |
|---|---|
| < 80% of L | Nothing. |
| 80% – < 100% | Allowed. Banner: "This workspace has used 80% of this month's AI credits." |
| 100% – < G | Allowed. Banner: "Over this month's AI credits: N left before AI actions pause." |
| ≥ G | Refused with **`credits_exhausted`** (429, `Retry-After` until period end): "This workspace has used this month's AI credits. They renew on <date>." The body carries `resetsAt` and `billingUrl` when `BILLING_URL` is set. |

Work already accepted into the worker queue always finishes and is charged.

**Indexing** — before each indexing job the worker checks `index_credits_used` against
`index_credits_per_month × (1 + grace_percent / 100)`. When it is reached the job is **held**, not failed: it is
rescheduled for the period's end, and the page shows "Saved · not indexed (indexing limit reached)". Held jobs are
released immediately when the limit is raised through the internal API, and on period reset. Top-ups add only to the
Capture and Ask pool, never to the index pool.

**Seats** — members plus pending invitations, both with a role other than viewer, are counted. Inviting, accepting an
invitation, or promoting a viewer that would exceed `seats` is refused with
**`seat_limit_reached`**. Nobody is removed after a downgrade; the workspace cannot add people until it is back under.

**Storage** — an upload that would exceed `storage_bytes` is refused with **`storage_limit_reached`**. Future Drive and
WhatsApp sync pause with a visible status in the same way.

**Warnings** — the first time a period crosses 80% and 100% of `L`, an in-app notification goes to every owner and
admin, and `warned_80_at` / `warned_100_at` is set so it is sent once.

**Fail open** — if the usage rows cannot be read, the action is allowed and the error is logged, as the existing
limits do. Billing must never take the product down.

**New error codes** in `@kinote/contracts`: `credits_exhausted` (429), `seat_limit_reached` (409),
`storage_limit_reached` (413).

## Usage page

Settings → **Usage**, for owners and admins: credits used of the limit (with top-ups and grace shown), index credits,
storage, seats, the plan label, and the date the period renews. With no limits, it shows usage only. The banner from
"Enforcement" appears at the top of the console for everyone in the workspace; the Upgrade link shows only to owners
and admins, and only when `BILLING_URL` is set.

## Control-plane API

**Mounting and security**

- Routes under `/internal/v1/` in the api app, registered only when **`CONTROL_PLANE_TOKENS`** is set (a
  comma-separated list, so tokens can be rotated). Otherwise the paths are 404.
- Bearer token, compared against the SHA-256 of each configured token in constant time. Wrong or missing token: 401.
- `docs/operations.md` says `/internal/` must not be exposed through the public reverse proxy; the token is a second
  guard.
- Calls across tenants go through `SECURITY DEFINER` functions (the `my_tenants` pattern). Calls for one tenant run in
  `withTenantTx`, so RLS still applies.
- Every write records an `audit_events` row with the actor `control_plane`.

**Endpoints**

| Endpoint | Does |
|---|---|
| `GET /internal/v1/info` | `{ kinoteVersion, apiVersion: 1, features: [...] }`. |
| `GET /internal/v1/tenants?cursor=&updatedSince=` | Paged tenants: id, slug, name, plan, createdAt, deletedAt, owner email, seat count. |
| `GET /internal/v1/tenants/:id` | One tenant with its limits and current-period usage. |
| `PUT /internal/v1/tenants/:id/limits` | Replaces the tenant's limits and sets `tenants.plan` from a `plan` label. Idempotent. `null` body removes all limits. Raising `index_credits_per_month` releases held indexing jobs. |
| `POST /internal/v1/tenants/:id/topups` | `{ credits, idempotencyKey }`. Adds credits to the current period's Capture and Ask pool. A repeated key returns the original result and adds nothing. |
| `GET /internal/v1/usage?period=&cursor=` | Paged current or given-period totals for every tenant. |

**The contract** — Zod schemas in `packages/contracts/src/internal.ts`, a written reference in
`docs/control-plane-api.md`. Within `v1` changes are additive only; anything breaking becomes `v2`. How Kinote-SaaS
consumes the schemas is decided in sub-project 2.

## Configuration

Added to `.env.example` and `docs/operations.md`:

| Setting | Default | Meaning |
|---|---|---|
| `MODEL_CREDIT_RATES` | unset (0 credits) | Model → credits per 1,000 input/output tokens, with `default`. Inline JSON or a path. |
| `CONTROL_PLANE_TOKENS` | unset (API off) | Comma-separated bearer tokens for `/internal/v1/`. |
| `BILLING_URL` | unset | Where Upgrade links point. |

`TENANT_DAILY_AI_ACTIONS` stays, documented as a safety net, not billing.

## Rollout

One migration adds `tenant_limits`, `usage_events`, `tenant_usage`, `credit_topups`, `tenant_storage` (backfilled
once from existing file versions), their RLS policies and the `SECURITY DEFINER` functions. No tenant gets limits, so
every existing workspace behaves as before; metering starts at deploy. The Progress table in
`docs/kinote-standalone-design.md` gets a row for this work.

## Testing

- **Unit (PGlite):** credit calculation (listed model, `default`, unset rates, estimated tokens); period boundaries
  across anchors and month ends; ledger and totals in step; each threshold (under 80%, 80%, 100%, inside grace, past
  grace) with and without top-ups; seat and storage rules including downgrade; top-up idempotency; warnings sent once.
- **API:** internal API with no token, wrong token, and each of two rotated tokens; 404 when unconfigured; every
  response parsed with its Zod schema; `credits_exhausted`, `seat_limit_reached`, `storage_limit_reached` bodies and
  `Retry-After`; audit rows written.
- **Worker:** an indexing job is held at the index limit and released by a limit increase and by period reset, and is
  not released by a top-up.
- **Postgres (`test:pg`):** RLS on every new table; cross-tenant functions reachable only through the internal API.
- **End-to-end (Playwright):** a workspace with tiny limits sees the 80% banner, the grace banner, the refusal with its
  renewal date, and the Usage page; a page shows "not indexed (indexing limit reached)" and becomes indexed after the
  limit is raised through the internal API.
