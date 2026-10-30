# Ports and reverse proxies

## One address

Everything people use goes through the **web** service: the app, the API under `/api`, live editing under `/collab`,
and the spreadsheet editor under `/gridcraft/`. So you only ever need one domain, pointed at the web service.

Locally, the web service is published on `http://localhost:8080` (`WEB_HOST_PORT`). The other services' host ports
(`55543` for Postgres, `59000`/`59001` for MinIO, `8787` for the API, `1234` for live editing, `8082` for the
spreadsheet editor) are bound to `127.0.0.1` for local tools and tests. On a server, you can remove the `ports:` entries
from `postgres`, `minio`, `api` and `collab` in `docker-compose.yml`; the web service doesn't need them.

Never expose the live-editing service's `/internal/*` paths or `INTERNAL_SECRET`. The web service already blocks
`/collab/internal/*`.

## Behind a reverse proxy: `TRUST_PROXY`

Kinote limits sign-up and sign-in attempts per client address. Behind a proxy, that address comes from the
`X-Forwarded-For` header, and `TRUST_PROXY` says how much of the header to believe.

| `TRUST_PROXY` | Client address | Use it when |
|---|---|---|
| `false` (default) | the direct connection; the header is ignored | nothing sits in front of Kinote's web service |
| `1`, `2`, … | that many hops from the right of the header | **recommended** behind proxies: the number of proxies in front of the API |
| `true` | the leftmost address | avoid: a client can send its own header and dodge the limit |

Your edge proxy must overwrite `X-Forwarded-For` or append the address it saw (nginx's `proxy_add_x_forwarded_for`,
Caddy and most load balancers do). Only count proxies that append to it.

## Coolify

The repository's `docker-compose.yml` works on Coolify as it is.

1. Create a **Docker Compose** resource from the repository, with compose path `docker-compose.yml` and branch `main`.
2. In **Environment Variables**, set the six secrets from the [Quick start](./) and `TRUST_PROXY=2` (Coolify's proxy
   plus Kinote's web service). Don't set `DATABASE_URL` or `DATABASE_MIGRATE_URL`. Set `S3_ENDPOINT` only for an
   external store.
3. Add your domain to the **web** service with internal port **80**. Don't add domains for any other service.
4. Deploy. The first build takes a while because of the file reader. Then open your domain.
