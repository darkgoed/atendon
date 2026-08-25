ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'UTC';

ALTER TABLE tenants
  DROP CONSTRAINT IF EXISTS tenants_timezone_not_empty;

ALTER TABLE tenants
  ADD CONSTRAINT tenants_timezone_not_empty CHECK (btrim(timezone) <> '');

COMMENT ON COLUMN tenants.timezone IS 'IANA time zone used for workspace-local scheduling';
