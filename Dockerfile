# One build for the services: the TypeScript entry points run with tsx (api,
# collab, worker), the migration is one-shot, and the console is built by Vite
# and served by nginx.
#
#   docker build --target api .
#   docker build --target web-runtime .
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

# The console: build the Vite app, then serve it and keep the browser on one
# origin. nginx proxies /api and /mcp to the api and /collab (WebSocket) to collab.
FROM build AS web
USER root
RUN pnpm --filter @kinote/web build

FROM nginx:1.27-alpine AS web-runtime
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=web /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=5s --timeout=3s --retries=20 CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1
