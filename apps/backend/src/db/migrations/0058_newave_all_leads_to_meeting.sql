-- Novas qualificações da Newave passam a ser somente contexto comercial:
-- nenhuma nota descarta ou bloqueia o lead antes da tentativa de agendamento.
-- Conversas historicamente transferidas não são reativadas automaticamente,
-- pois podem já estar sob atendimento humano.
UPDATE tenant_ai_settings s
SET ai_follow_up_enabled = true,
    ai_follow_up_max_count = 3,
    updated_at = now()
FROM tenants t
WHERE t.id = s.tenant_id
  AND t.slug = 'newave-ia';
