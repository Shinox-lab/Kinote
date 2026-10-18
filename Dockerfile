# One build for every service. Services run their TypeScript entry points with
# tsx; production bundling is deferred.
#
#   docker build --target api .     (also: collab, worker, migrate)
FROM node:22-slim AS build
WORKDIR /app
# pnpm is fetched once at build time into a shared COREPACK_HOME so the
# unprivileged runtime user can run it without network access.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 COREPACK_HOME=/opt/corepack
COPY package.json ./
RUN corepack enable && corepack install && chmod -R a+rX /opt/corepack

# Manifests first so the dependency layer is cached across source changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/api/package.json apps/api/
COPY apps/collab/package.json apps/collab/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/contracts/package.json packages/contracts/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile

COPY . .
ENV NODE_ENV=production
USER node

# One-shot: applies packages/db/migrations to DATABASE_MIGRATE_URL.
FROM build AS migrate
CMD ["pnpm", "db:migrate"]

FROM build AS api
EXPOSE 8787
CMD ["node_modules/.bin/tsx", "apps/api/src/main.ts"]

FROM build AS collab
EXPOSE 1234
CMD ["node_modules/.bin/tsx", "apps/collab/src/main.ts"]

FROM build AS worker
CMD ["node_modules/.bin/tsx", "apps/worker/src/main.ts"]
