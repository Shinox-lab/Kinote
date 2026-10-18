# Postgres 17 + pgvector with the role init script baked in (built by
# docker-compose.yml). Copying the script, rather than bind-mounting it from
# the checkout, keeps the stack working where host file sharing is restricted
# (e.g. Docker Desktop without access to the folder holding the repo).
FROM pgvector/pgvector:pg17
COPY 01-roles.sh /docker-entrypoint-initdb.d/01-roles.sh
