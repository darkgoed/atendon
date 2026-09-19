-- ONDA 2-B (SPEC v7) — B10: configuração de retenção de armazenamento em meses.
-- A config legada (tenants.storage_retention_days, 0173) continua válida; a
-- UI passa a usar {retention:{enabled,months}} persistido em
-- storage_retention_enabled/storage_retention_months. O job diário EXISTENTE
-- (runStorageRetention) resolve a config ativa: meses quando habilitado, dias
-- legados caso contrário — nenhuma segunda regra de exclusão é criada.
-- Aditiva e idempotente.
-- ROLLBACK (manual, não executar automaticamente):
-- ALTER TABLE tenants DROP COLUMN IF EXISTS storage_retention_months;
-- ALTER TABLE tenants DROP COLUMN IF EXISTS storage_retention_enabled;

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS storage_retention_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS storage_retention_months INTEGER;

DO $$
BEGIN
  ALTER TABLE tenants ADD CONSTRAINT tenants_storage_retention_months_range
    CHECK (storage_retention_months IS NULL OR storage_retention_months BETWEEN 1 AND 1200);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

COMMENT ON COLUMN tenants.storage_retention_enabled IS
  'Retenção de mídias armazenada em meses ativa (storage_retention_months); false = usar storage_retention_days legado';
COMMENT ON COLUMN tenants.storage_retention_months IS
  'Janela de retenção em meses (config nova, B10); job diário existente exclui assets mais antigos que N*30 dias';
