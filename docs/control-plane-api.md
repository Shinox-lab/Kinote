# Control-plane API (`/internal/v1/`)

How a control plane (Kinote-SaaS) sets a workspace's limits, adds credit top-ups and reads usage. Kinote stores
numbers only: it knows nothing of plan names, prices or payments. Design:
`docs/superpowers/specs/2026-11-03-plans-usage-quotas-design.md`. Zod schemas: `packages/contracts/src/internal.ts`.

## Turning it on

The API exists only when `CONTROL_PLANE_TOKENS` is set (see `docs/operations.md`, "Plans and usage"). Unset, every
`/internal/` path answers 404.

`/internal/` must not be exposed through the public reverse proxy. The web nginx forwards only `/api/`, `/mcp` and
`/collab`, so it is not; call the api over the internal network. The token is a second guard.

## Authentication

```
Authorization: Bearer <token>
```

`CONTROL_PLANE_TOKENS` is a comma-separated list (each token at least 32 characters), so a token can be rotated: add
the new one, move the control plane to it, then remove the old one. Tokens are compared by SHA-256 in constant time.
A missing or wrong token answers `401 unauthenticated`. A console session is not a token.

`CONTROL_PLANE_ALLOWED_IPS` (comma-separated IPv4/IPv6 addresses or CIDRs, e.g. `203.0.113.10,10.0.0.0/8`) limits
which client addresses may call the API at all. The client address is the one `TRUST_PROXY` resolves. A request from
any other address answers `403 forbidden` before the token is looked at. Empty or unset: any address (the shared
deployment, where the control plane reaches Kinote over a private network). Dedicated instances set it to the control
plane's outbound address, since their API is reachable from the internet.

## Conventions

- Bodies are JSON with camelCase fields. Credits are numbers with up to 3 decimals; bytes and seats are integers.
- `null` for a limit means unlimited.
- Errors use Kinote's usual shape: `{ "error": "<code>", "message": "<sentence>" }`, with `issues` on `400 validation_failed`.
- Every write records an audit event in the workspace (`limits.updated`, `credits.topup`, `billing.state_updated`) with actor type `system`,
  actor id `00000000-0000-0000-0000-000000000000` and `payload.by = "control_plane"`.
- **Within `v1` changes are additive only** (new fields, new endpoints, new `features`). Anything that would break a
  client becomes `v2`. Clients must ignore fields they do not know.

## Usage numbers

`usage` objects (in `/tenants/:id` and `/usage`) are computed the same way:

| Field | Meaning |
|---|---|
| `period` | Start date of the period (UTC, `YYYY-MM-DD`). Periods start on the workspace's `periodAnchorDay`. |
| `periodEnd` | When the period ends (exclusive, ISO). |
| `creditsUsed` | Capture and Ask credits used this period. |
| `indexCreditsUsed` | Indexing credits used this period. |
| `creditsTopup` | Credits added to this period by top-ups. |
| `storageBytes` | Stored file bytes now: every stored file version. Archiving a file does not free its bytes (there is no purge yet), so this only grows. |
| `seats` | Members plus pending invitations, both not viewers. Agents never count. |
| `state` | `unlimited`, `ok`, `warn` (≥ 80% of limit + top-ups), `over` (≥ 100%), `exhausted` (≥ grace limit: Capture and Ask are refused). |
| `indexHeld` | Indexing waits for the period's end (index credits at their limit + grace). |

## Endpoints

### `GET /internal/v1/info`

```json
{ "kinoteVersion": "0.1.0", "apiVersion": 1, "features": ["limits", "usage", "topups", "billing_state", "default_limits"] }
```

`kinoteVersion` is `KINOTE_VERSION`, which release images carry (`X.Y.Z` for the tag `vX.Y.Z`); an image built from
source reports the api package's version instead.

### `GET /internal/v1/tenants?after=<id>&limit=<n>`

Every workspace, deleted ones included, in creation order. `limit` defaults to 100 (at most 500). `next` is the id to
pass as `after` for the next page, or `null` on the last page.

```json
{
  "tenants": [
    {
      "id": "6f1c…",
      "slug": "acme",
      "name": "Acme",
      "plan": "team",
      "createdAt": "2026-11-03T10:00:00.000Z",
      "deletedAt": null,
      "ownerEmail": "owner@acme.example",
      "seats": 4,
      "billingState": { "state": "ok", "manageUrl": null }
    }
  ],
  "next": "6f1c…"
}
```

**Paging, not `updatedSince`.** The spec's `updatedSince` filter was replaced by keyset paging on
`(createdAt, id)`. New workspaces always come last, so a control plane picks up sign-ups by paging on from the last
id it saw.

### `GET /internal/v1/tenants/:id`

One workspace with its limits (`null`: none) and current-period usage. A deleted workspace is returned with
`deletedAt` set. Unknown: `404 tenant_not_found`. It carries `billingState` as in the listing (a server without
the `billing_state` feature leaves the field out; treat that as `ok`).

```json
{
  "id": "6f1c…", "slug": "acme", "name": "Acme", "plan": "team",
  "createdAt": "2026-11-03T10:00:00.000Z", "deletedAt": null, "ownerEmail": "owner@acme.example", "seats": 4,
  "limits": {
    "seats": 5, "storageBytes": 10737418240, "creditsPerMonth": 2000, "indexCreditsPerMonth": 5000,
    "gracePercent": 10, "periodAnchorDay": 1
  },
  "usage": {
    "period": "2026-11-01", "periodEnd": "2026-12-01T00:00:00.000Z",
    "creditsUsed": 1650.125, "indexCreditsUsed": 812.5, "creditsTopup": 0,
    "storageBytes": 52428800, "seats": 4, "state": "warn", "indexHeld": false
  }
}
```

### `PUT /internal/v1/tenants/:id/limits`

Replaces the workspace's limits and sets its plan label. Idempotent. Answers the workspace as `GET /tenants/:id` does.

```json
{
  "plan": "team",
  "seats": 5,
  "storageBytes": 10737418240,
  "creditsPerMonth": 2000,
  "indexCreditsPerMonth": 5000,
  "gracePercent": 10,
  "periodAnchorDay": 1
}
```

`plan` (1–40 characters) is a display label. `seats`, `storageBytes`, `creditsPerMonth` and `indexCreditsPerMonth` are
required: an integer ≥ 0, or `null` for unlimited. `gracePercent` (0–100, default 10) and `periodAnchorDay` (1–28,
default 1) are optional.

A body of `null` removes every limit and sets the plan label back to `standard`: the workspace is unlimited at once.

Every PUT releases indexing that was held at the limit; jobs still over a new limit are held again when they run.
Lowering a limit below current usage removes nobody and deletes nothing: the workspace cannot add people, files or AI
actions until it is back under. Unknown or deleted workspace: `404 tenant_not_found`.

### `POST /internal/v1/tenants/:id/topups`

Adds credits to the **current period's** Capture and Ask pool (never to indexing). A top-up does not carry over to the
next period.

```json
{ "credits": 500, "idempotencyKey": "order-8812" }
```

`201` with the workspace (as `GET /tenants/:id`) when added. Repeating an `idempotencyKey` adds nothing and answers
`200` with the same body shape. Unknown or deleted workspace: `404 tenant_not_found`.

### `PUT /internal/v1/tenants/:id/billing-state`

Where the workspace stands with its payments. Feature `billing_state`.

```json
{ "state": "past_due", "manageUrl": "https://billing.example.com/portal" }
```

| `state` | Effect |
|---|---|
| `ok` | Nothing. |
| `past_due` | Everything works; owners and admins see "Payment failed — update billing", linking to `manageUrl`. |
| `suspended` | Read-only: every write answers `423 workspace_suspended` (sign-in, sign-out and reads still work), AI is refused, background indexing is held, and live editing reconnects read-only. Every member sees "This workspace is suspended"; owners and admins also get the `manageUrl` link. |

Both fields are required; `manageUrl` may be `null`. Answers `200` with the workspace (as `GET /tenants/:id`).
Repeating the same body changes nothing and writes no audit event. Lifting a suspension lets held indexing run at
once. Unknown or deleted workspace: `404 tenant_not_found`.

### `GET /internal/v1/defaults` and `PUT /internal/v1/defaults`

Limits every new workspace starts with, until the control plane sets its own. Feature `default_limits`.

```json
{ "plan": "free", "seats": 3, "storageBytes": 1073741824, "creditsPerMonth": 100, "indexCreditsPerMonth": 200, "gracePercent": 10, "maxFreePerOwner": 2 }
```

The limit fields work as in `PUT /tenants/:id/limits` (`null` is unlimited; `gracePercent` defaults to 10; no
`periodAnchorDay`: a new workspace's periods start on the day it was created, at most the 28th). `maxFreePerOwner`
(`null`: no cap) is how many live workspaces on `plan` one person may own: creating another answers
`409 free_workspace_limit`; workspaces on other plans do not count. `PUT` with `null` removes the defaults, and new
workspaces are unlimited again, as they are when nothing was ever set. Both answer `{ "defaults": … | null }`.
Workspaces that already exist are not changed.

### `GET /internal/v1/usage?period=<YYYY-MM-DD>&after=<id>&limit=<n>`

Usage for every workspace, paged like `/tenants`. Without `period`, each workspace's current period. With `period`,
the period containing that date for each workspace.

```json
{
  "usage": [
    {
      "tenantId": "6f1c…",
      "period": "2026-11-01", "periodEnd": "2026-12-01T00:00:00.000Z",
      "creditsUsed": 1650.125, "indexCreditsUsed": 812.5, "creditsTopup": 0,
      "storageBytes": 52428800, "seats": 4, "state": "warn", "indexHeld": false
    }
  ],
  "next": null
}
```

## Error codes

| Status | Code | When |
|---|---|---|
| 400 | `validation_failed` | A body or query that does not match its schema. |
| 401 | `unauthenticated` | No `Authorization: Bearer`, or a token not in `CONTROL_PLANE_TOKENS`. |
| 403 | `forbidden` | The client address is not in `CONTROL_PLANE_ALLOWED_IPS` (checked first). |
| 404 | `tenant_not_found` | Unknown workspace (or, for writes, a deleted one). |
| 404 | (as any unknown path) | Any `/internal/` path while `CONTROL_PLANE_TOKENS` is unset. |

What members see when a limit is reached: `credits_exhausted` (429, with `Retry-After`, `resetsAt` and, with
`BILLING_URL`, `billingUrl`), `seat_limit_reached` (409) and `storage_limit_reached` (413). Creating a workspace past the defaults'
`maxFreePerOwner`: `free_workspace_limit` (409, with `billingUrl` when `BILLING_URL` is set). While suspended: `workspace_suspended` (423, with
`manageUrl` for owners and admins).
