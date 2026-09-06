-- U1: homologation is data, while the database prevents enabling an
-- unhomologated provider. This migration is idempotent and non-destructive.
ALTER TABLE billing_providers
  ADD COLUMN IF NOT EXISTS homologated boolean NOT NULL DEFAULT false;

UPDATE billing_providers
SET homologated = true, updated_at = now()
WHERE code = 'mercadopago';

UPDATE billing_providers
SET enabled = false, updated_at = now()
WHERE enabled = true AND homologated = false;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'billing_providers_only_homologated_enabled') THEN
    ALTER TABLE billing_providers DROP CONSTRAINT billing_providers_only_homologated_enabled;
  END IF;
  ALTER TABLE billing_providers ADD CONSTRAINT billing_providers_only_homologated_enabled
    CHECK (enabled = false OR homologated = true);
EXCEPTION WHEN duplicate_object THEN
  NULL;
END $$;
