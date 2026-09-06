#!/bin/sh
set -eu
# Runs only when the development volume is first initialized. psql quotes the secret as a SQL literal.
psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -v ON_ERROR_STOP=1 <<'SQL'
\getenv runtime_password SAND_RUNTIME_DB_PASSWORD
SELECT format('CREATE ROLE sand_runtime LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD %L', :'runtime_password') \gexec
SQL
