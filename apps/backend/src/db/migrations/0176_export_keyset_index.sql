-- Índice keyset do export CSV de contatos (R15, contact-ops/service.ts
-- exportLeadsCsv): a paginação ordena por (tenant_id, created_at, id) e sem
-- este índice cada página de 500 linhas varre a tabela do tenant.
-- Aditiva e idempotente.
-- ROLLBACK (manual, não executar automaticamente):
-- DROP INDEX IF EXISTS idx_scheduling_leads_created_keyset;

CREATE INDEX IF NOT EXISTS idx_scheduling_leads_created_keyset
  ON scheduling_leads(tenant_id, created_at, id);
