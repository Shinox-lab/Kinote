# Upgrading and backups

## Upgrading

```sh
git pull
docker compose up -d --build
```

The one-shot `migrate` service upgrades the database before the API, live editing and the worker start again. It's
safe to run more than once.

Read the release notes before you upgrade. Some upgrades rebuild the search index; while that runs, search may miss
documents that haven't been re-indexed yet.

### Sign-up by invitation

**After this upgrade, only people with an invitation link can create an account** on a server that already has
accounts. `SIGNUP_MODE` defaults to `auto`: open until the first account exists, then invitation only. To keep
letting anyone sign up, set `SIGNUP_MODE=open`. Someone who signs up from an invitation link gets the invited email
and joins the workspace in the same step.

### Accounts

- **Sessions last 14 days** from the last time they were used, and at most 90 days in all. People who use Kinote
  every week stay signed in; after that, they sign in again.
- **Everyone can change their password and sign out everywhere** from *Account and security* in the account menu.
- **Source tokens now expire.** New ones last 90 days unless you choose 1 to 365. Existing tokens that never expire
  are marked on the Sources page; replace them with ones that do.
- **Media links stop working as soon as the person loses access**, instead of after 15 minutes.
- **Email is optional.** See [Email](./configuration#email-optional) for verification and password reset by email,
  and for the operator's reset command.

### Security headers and sign-in limits

This upgrade changes a few things you may notice:

- **`TRUST_PROXY` now defaults to `1`** in Docker Compose, so each person gets their own sign-in limit instead of
  sharing the web service's. If you set `TRUST_PROXY=false` yourself, change it to `1` (or `2` behind Coolify or
  another proxy).
- **Images from other sites no longer show in pages.** The app now sends a Content-Security-Policy that only loads
  images, fonts and scripts from Kinote itself. Upload the image instead of linking to it.
- **Drawings can't embed other sites** (YouTube, Figma and similar).
- **The app can't be shown inside another site's frame.**
- **Live editing has message and connection limits:** one message is at most `COLLAB_MAX_MESSAGE_BYTES` (8 MiB),
  and one client address can hold at most 100 live-editing connections.

### Usage limits and the daily AI allowance

- **Each person's requests are limited per minute:** Ask (10), Search (60), captures (20) and file uploads (30).
  Creating workspaces is limited to 5 an hour, and one person may own at most 5.
- **Each workspace has a daily AI allowance** of 2,000 AI actions (`TENANT_DAILY_AI_ACTIONS`): each Ask, and each
  capture routed or placed, page card or entity extraction. Search and indexing aren't counted. Once it's used up, Ask
  and new captures are refused until midnight UTC and background AI work waits until then. Set it to `0` to turn it
  off, or higher for a busy workspace.
- **Failed sign-ins are also counted per account.** After five in 15 minutes the account is locked briefly.
- **The limits are shared by every API copy,** through a new database table (`rate_limit_counters`) that the
  upgrade creates.

Every limit is a setting; see [Configuration](./configuration).

## Where your data lives

| What | Where |
|---|---|
| Database (pages, versions, comments, members, the search index) | Docker volume `kinote_pgdata` |
| Uploaded files (bundled MinIO) | Docker volume `kinote_miniodata`, or your external S3 bucket |

Both volumes survive `docker compose restart`, `stop`, `start` and a plain `docker compose down`.
**`docker compose down -v` deletes them**, and so does `pnpm stack:down`.

## Backups

Back up both the database and the files, at the same time if you can.

**Database:**

```sh
docker compose exec -T postgres pg_dump -U postgres -Fc kinote > kinote-$(date +%F).dump
```

Restore into an empty database with `pg_restore`.

**Files (bundled MinIO):** copy the bucket with any S3 tool, such as the MinIO client:

```sh
mc alias set kinote http://localhost:59000 "$S3_ACCESS_KEY" "$S3_SECRET_KEY"
mc mirror kinote/kinote ./kinote-files-$(date +%F)
```

For an external S3 store, use your provider's own backups or versioning.
