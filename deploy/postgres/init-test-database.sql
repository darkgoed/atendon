\set ON_ERROR_STOP on

-- The test runner refuses to use the application database. Create its local
-- default on first volume initialization so a fresh clone is usable as-is.
SELECT 'CREATE DATABASE atendon_test'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'atendon_test')\gexec
