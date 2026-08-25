#!/bin/sh
set -eu

: "${POSTGRES_DB:?POSTGRES_DB is required}"
: "${ATENDON_MIGRATION_DB_PASSWORD:?ATENDON_MIGRATION_DB_PASSWORD is required}"
: "${ATENDON_RUNTIME_DB_PASSWORD:?ATENDON_RUNTIME_DB_PASSWORD is required}"

# The official postgres image exposes bootstrap credentials as POSTGRES_*.
# psql otherwise defaults to the container OS user (usually root) during a
# manual `docker compose exec`, so map them unless the operator supplied an
# explicit PGUSER/PGPASSWORD pair.
PGUSER="${PGUSER:-${POSTGRES_USER:?POSTGRES_USER or PGUSER is required}}"
PGPASSWORD="${PGPASSWORD:-${POSTGRES_PASSWORD:?POSTGRES_PASSWORD or PGPASSWORD is required}}"
export PGUSER PGPASSWORD

owner_role="${ATENDON_OWNER_DB_ROLE:-atendon_owner}"
migration_role="${ATENDON_MIGRATION_DB_USER:-atendon_migration}"
runtime_role="${ATENDON_RUNTIME_DB_USER:-atendon_app}"

for role in "$owner_role" "$migration_role" "$runtime_role"; do
  case "$role" in
    ""|*[!a-z0-9_$]*|[0-9$]*)
      echo "Unsafe PostgreSQL role identifier: $role" >&2
      exit 1
      ;;
  esac
done

if [ "$owner_role" = "$migration_role" ] \
  || [ "$owner_role" = "$runtime_role" ] \
  || [ "$migration_role" = "$runtime_role" ]; then
  echo "Owner, migration and runtime roles must be distinct" >&2
  exit 1
fi

psql \
  --set=ON_ERROR_STOP=1 \
  --set=database="$POSTGRES_DB" \
  --set=owner_role="$owner_role" \
  --set=migration_role="$migration_role" \
  --set=migration_password="$ATENDON_MIGRATION_DB_PASSWORD" \
  --set=runtime_role="$runtime_role" \
  --set=runtime_password="$ATENDON_RUNTIME_DB_PASSWORD" \
  --dbname=postgres <<'SQL'
-- O owner e NOLOGIN e so e alcancado via SET ROLE pela role de migration.
-- Ele precisa de BYPASSRLS porque as tabelas do piloto usam FORCE ROW LEVEL
-- SECURITY: sem bypass, pg_dump com --role=owner falha fechado e o backup
-- pos-deploy fica impossivel. A role runtime continua NOBYPASSRLS e tem o
-- owner revogado logo abaixo, entao o isolamento por tenant nao muda.
SELECT format(
  'CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS',
  :'owner_role'
)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=:'owner_role')
\gexec

SELECT format(
  'ALTER ROLE %I NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS',
  :'owner_role'
)
\gexec

SELECT format(
  'CREATE ROLE %I LOGIN PASSWORD %L NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',
  :'migration_role',
  :'migration_password'
)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=:'migration_role')
\gexec

SELECT format(
  'ALTER ROLE %I LOGIN PASSWORD %L NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',
  :'migration_role',
  :'migration_password'
)
\gexec

SELECT format(
  'CREATE ROLE %I LOGIN PASSWORD %L NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',
  :'runtime_role',
  :'runtime_password'
)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=:'runtime_role')
\gexec

SELECT format(
  'ALTER ROLE %I LOGIN PASSWORD %L NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',
  :'runtime_role',
  :'runtime_password'
)
\gexec

SELECT format('GRANT %I TO %I', :'owner_role', :'migration_role')
\gexec
SELECT format('REVOKE %I FROM %I', :'owner_role', :'runtime_role')
\gexec

SELECT format('ALTER DATABASE %I OWNER TO %I', :'database', :'owner_role')
\gexec
SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', :'database')
\gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO %I', :'database', :'migration_role')
\gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO %I', :'database', :'runtime_role')
\gexec

\connect :database

CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

SELECT format('ALTER SCHEMA public OWNER TO %I', :'owner_role')
\gexec
REVOKE ALL ON SCHEMA public FROM PUBLIC;
SELECT format('REVOKE ALL ON SCHEMA public FROM %I', :'runtime_role')
\gexec
SELECT format('GRANT USAGE ON SCHEMA public TO %I', :'runtime_role')
\gexec

SELECT format(
  'ALTER TABLE %I.%I OWNER TO %I',
  namespace.nspname,
  relation.relname,
  :'owner_role'
)
FROM pg_class relation
JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
WHERE namespace.nspname='public' AND relation.relkind IN ('r','p')
  AND NOT EXISTS (
    SELECT 1 FROM pg_depend dependency
    WHERE dependency.classid='pg_class'::regclass
      AND dependency.objid=relation.oid
      AND dependency.deptype='e'
  )
\gexec

SELECT format(
  'ALTER SEQUENCE %I.%I OWNER TO %I',
  namespace.nspname,
  relation.relname,
  :'owner_role'
)
FROM pg_class relation
JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
WHERE namespace.nspname='public' AND relation.relkind='S'
  AND NOT EXISTS (
    SELECT 1 FROM pg_depend dependency
    WHERE dependency.classid='pg_class'::regclass
      AND dependency.objid=relation.oid
      AND dependency.deptype='e'
  )
\gexec

SELECT format(
  'ALTER %s %I.%I OWNER TO %I',
  CASE relation.relkind WHEN 'm' THEN 'MATERIALIZED VIEW' ELSE 'VIEW' END,
  namespace.nspname,
  relation.relname,
  :'owner_role'
)
FROM pg_class relation
JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
WHERE namespace.nspname='public' AND relation.relkind IN ('v','m')
  AND NOT EXISTS (
    SELECT 1 FROM pg_depend dependency
    WHERE dependency.classid='pg_class'::regclass
      AND dependency.objid=relation.oid
      AND dependency.deptype='e'
  )
\gexec

SELECT format(
  'ALTER FUNCTION %I.%I(%s) OWNER TO %I',
  namespace.nspname,
  procedure.proname,
  pg_get_function_identity_arguments(procedure.oid),
  :'owner_role'
)
FROM pg_proc procedure
JOIN pg_namespace namespace ON namespace.oid=procedure.pronamespace
WHERE namespace.nspname='public' AND procedure.prokind='f'
  AND NOT EXISTS (
    SELECT 1 FROM pg_depend dependency
    WHERE dependency.classid='pg_proc'::regclass
      AND dependency.objid=procedure.oid
      AND dependency.deptype='e'
  )
\gexec

SELECT format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', :'runtime_role')
\gexec
SELECT format(
  'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.%I TO %I',
  namespace.nspname,
  relation.relname,
  :'runtime_role'
)
FROM pg_class relation
JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
WHERE namespace.nspname='public' AND relation.relkind IN ('r','p')
  AND NOT EXISTS (
    SELECT 1 FROM pg_depend dependency
    WHERE dependency.classid='pg_class'::regclass
      AND dependency.objid=relation.oid
      AND dependency.deptype='e'
  )
\gexec
SELECT format(
  'GRANT SELECT ON TABLE public.pg_stat_statements TO %I',
  :'runtime_role'
)
WHERE to_regclass('public.pg_stat_statements') IS NOT NULL
\gexec
SELECT format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', :'runtime_role')
\gexec
SELECT format(
  'GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO %I',
  :'runtime_role'
)
\gexec

SELECT format(
  'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I',
  :'owner_role',
  :'runtime_role'
)
\gexec
SELECT format(
  'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO %I',
  :'owner_role',
  :'runtime_role'
)
\gexec
SQL

echo "AtendON PostgreSQL roles provisioned for database $POSTGRES_DB"
