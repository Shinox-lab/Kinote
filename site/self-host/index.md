# Quick start

Run Kinote on your own machine or server with Docker Compose. One command starts everything: the app, the database,
file storage and the file reader.

## What you need

- **Docker** with Docker Compose (Docker Desktop on a Mac or Windows).
- **About 4 GB of free memory.** The file reader that pulls text out of PDFs and Office documents needs about 2 GB
  while it reads a file.
- **Disk space and time for the first build.** The file reader's image includes its models and is several gigabytes,
  so the first start takes a while.
- **Optional: a model provider.** Search, Ask and routing need an OpenAI-compatible embeddings model and chat model,
  either hosted (for example OpenRouter) or your own. You can start without one and add it later; see
  [Configuration](./configuration#models).

## 1. Get the code

```sh
git clone https://github.com/Shinox-lab/Kinote.git
cd Kinote
cp .env.example .env
```

## 2. Fill in the six secrets

Kinote has no default passwords. Open `.env` and set these six values. Each should be a long random string; this
command makes one:

```sh
openssl rand -hex 32
```

| Setting | What it is |
|---|---|
| `POSTGRES_PASSWORD` | The database's administrator password |
| `APP_DB_PASSWORD` | The password of the restricted database user the app runs as |
| `COLLAB_TOKEN_SECRET` | Signs the tokens for live editing (at least 32 characters) |
| `INTERNAL_SECRET` | Lets the app's own services talk to each other (at least 32 characters) |
| `S3_ACCESS_KEY` | The file storage user name (also the bundled MinIO's admin user) |
| `S3_SECRET_KEY` | The file storage password (also the bundled MinIO's admin password) |

Leave `DATABASE_URL` and `DATABASE_MIGRATE_URL` empty when you use Docker Compose; it builds its own.

## 3. Start it

```sh
docker compose up -d
```

The database is set up automatically before the app starts. When the containers are healthy, open
`http://localhost:8081`.

`pnpm dev` does the same if you have Node.js and pnpm: it checks `.env`, builds everything and
waits until it's healthy.

## 4. Sign up

Click **Sign up**, enter your name, email and a password, then create your first workspace with a name and a URL slug.
You're its owner. Invite your team from **Settings & members**.

::: warning Anyone who can reach it can sign up
Each new account can create its own workspace, and it can't see anyone else's. Still, if your Kinote is on the
public internet, put it behind your own network access rules if you don't want strangers creating accounts.
:::

## Next steps

- [Configuration](./configuration): every setting, and how to connect models.
- [Ports and reverse proxies](./proxy): putting Kinote on a domain, including Coolify.
- [Upgrading and backups](./upgrading).
