-- B5 Merge de contatos (specs/active/v7-port-crm-whatsapp.md, ONDA 2, R11):
-- destino de mesclagem do lead. O source fica soft-deleted (deleted_at, R17)
-- apontando para o principal; UNIQUE(tenant_id,phone) é preservada (o source
-- mantém o próprio telefone — nenhuma linha é copiada por cima do target).
-- Aditiva e idempotente.
-- ROLLBACK (manual, não executar automaticamente):
-- ALTER TABLE scheduling_leads DROP CONSTRAINT IF EXISTS scheduling_leads_no_self_merge;
-- ALTER TABLE scheduling_leads DROP CONSTRAINT IF EXISTS scheduling_leads_merged_into_tenant_fkey;
-- ALTER TABLE scheduling_leads DROP COLUMN IF EXISTS merged_into_id;

ALTER TABLE scheduling_leads ADD COLUMN IF NOT EXISTS merged_into_id UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'scheduling_leads_merged_into_tenant_fkey'
      AND conrelid = 'scheduling_leads'::regclass
  ) THEN
    ALTER TABLE scheduling_leads
      ADD CONSTRAINT scheduling_leads_merged_into_tenant_fkey
      FOREIGN KEY (merged_into_id, tenant_id)
      REFERENCES scheduling_leads(id, tenant_id)
      -- Excluir definitivamente o principal da lixeira solta os sources
      -- (merged_into_id=NULL, permanecem na lixeira como contatos normais).
      ON DELETE SET NULL (merged_into_id);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'scheduling_leads_no_self_merge'
      AND conrelid = 'scheduling_leads'::regclass
  ) THEN
    ALTER TABLE scheduling_leads
      ADD CONSTRAINT scheduling_leads_no_self_merge
      CHECK (merged_into_id IS NULL OR merged_into_id <> id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_scheduling_leads_merged_into
  ON scheduling_leads(tenant_id, merged_into_id)
  WHERE merged_into_id IS NOT NULL;
