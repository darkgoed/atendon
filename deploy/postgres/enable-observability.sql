\set ON_ERROR_STOP on

-- shared_preload_libraries is configured by docker-compose.yml. The extension
-- creation is idempotent for new volumes; existing volumes use the operational
-- runbook after the required PostgreSQL restart.
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
