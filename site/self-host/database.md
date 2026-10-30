# Database and row-level security

Kinote stores everything in PostgreSQL 17 with the pgvector extension. Compose runs it for you; this page explains how
it keeps workspaces apart, which matters if you manage the database yourself.

## Two database users

| Setting | User | Used by |
|---|---|---|
| `DATABASE_URL` | `kinote_app`: can log in, but isn't a superuser and can't bypass row-level security | the API, live editing and the worker, all the time |
| `DATABASE_MIGRATE_URL` | the owner of the schema: a superuser, or a user that can bypass row-level security | setting up and upgrading the database only |

Never run a service with `DATABASE_MIGRATE_URL`.

With Compose, `kinote_app` is created automatically the first time the database starts, with the password from
`APP_DB_PASSWORD`, and the one-shot `migrate` service sets up the schema before the other services start.

## Row-level security

Every table that holds a workspace's data has row-level security turned on and **forced**, so it applies even to the
table's owner. Each policy only lets a query see rows whose workspace matches the workspace of the current request.
The app's own user can't switch this off.

So even a bug in a query can't return another workspace's rows: the database itself refuses. The test suite checks
that `kinote_app` is neither a superuser nor able to bypass row-level security, and that every policy compares the
workspace column with the current workspace.

## Your own Postgres

If you'd rather use a managed Postgres:

1. Use PostgreSQL 17 with the `vector` extension available.
2. Create the `kinote_app` login role without superuser or `BYPASSRLS`. `infra/postgres/01-roles.sh` shows exactly
   how, and is safe to run again.
3. Run the migrations with an owner role: `DATABASE_MIGRATE_URL=… pnpm db:migrate`.
4. Point the services at it with `DATABASE_URL=postgres://kinote_app:…@your-host/kinote`.

If you run the migrations before creating `kinote_app`, they create it without a login; run `01-roles.sh` afterwards
to give it one.
