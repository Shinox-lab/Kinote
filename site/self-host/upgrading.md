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
