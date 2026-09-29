-- Índice de expressão para o matching por telefone NORMALIZADO usado na
-- resolução de identidade (trigger link_conversation_to_lead da 0205, guarda
-- do automatic_lead e candidate do lead CTE em messages/repository.ts).
-- Sem este índice, cada conversa nova/entrada faz seq scan em
-- scheduling_leads por tenant. Aditivo e idempotente.
CREATE INDEX IF NOT EXISTS idx_scheduling_leads_tenant_phone_normalized
  ON scheduling_leads(tenant_id, regexp_replace(phone,'\D','','g'));
