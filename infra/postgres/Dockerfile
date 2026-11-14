# Postgres 17 + pgvector with the role init script baked in (built by
# docker-compose.yml). Copying the script, rather than bind-mounting it from
# the checkout, keeps the stack working where host file sharing is restricted
# (e.g. Docker Desktop without access to the folder holding the repo).
FROM pgvector/pgvector:pg17
# The release (X.Y.Z), set by the release workflow; empty in a build from source.
ARG KINOTE_VERSION=
ENV KINOTE_VERSION=${KINOTE_VERSION}
LABEL org.opencontainers.image.version=${KINOTE_VERSION}
COPY 01-roles.sh /docker-entrypoint-initdb.d/01-roles.sh
