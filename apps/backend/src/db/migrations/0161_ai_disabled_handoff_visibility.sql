-- Corrige um bug de visibilidade: `conversations.ai_active` (switch por
-- conversa, usado pelos filtros "Abertas"/"IA" do painel e por
-- unread-counts) é uma coluna diferente de `agent_configs.is_active`
-- (switch global da empresa, "Desativar IA"). O código de resposta da IA já
-- combina os dois corretamente (ver ConversationContext.aiActive em
-- modules/messages/repository.ts): quando o agente está desativado
-- globalmente ou bloqueado por regra comercial, a IA não responde. Mas essa
-- decisão nunca era persistida de volta em `conversations.ai_active`, então
-- a conversa continuava marcada como pertencente à IA no banco: sumia do
-- filtro humano ("Abertas") e o lead ficava em limbo, sem resposta da IA e
-- sem visibilidade para atendimento humano.
--
-- Esta migration tem duas partes:
-- 1) Novo motivo de handoff `agent_disabled`, para o atendente entender por
--    que a conversa chegou até ele sem pedido do contato nem pausa manual.
-- 2) Backfill idempotente: marca como `ai_active=false` (com esse motivo)
--    toda conversa aberta cujo agente resolvido (override da conexão, ou o
--    compartilhado do tenant, na mesma ordem de precedência usada em
--    runtime) já está desativado. Não altera conversas cujo agente está
--    ativo nem conversas já sinalizadas para o humano.

ALTER TABLE conversations
  DROP CONSTRAINT IF EXISTS conversations_handoff_reason_check;
ALTER TABLE conversations
  ADD CONSTRAINT conversations_handoff_reason_check CHECK (
    handoff_reason IS NULL OR handoff_reason IN (
      'ai_decided','contact_requested','manually_paused','technical_failure',
      'commercial_handoff','agent_disabled'
    )
  );

WITH resolved_agent AS (
  SELECT DISTINCT ON (c.id)
    c.id conversation_id,
    a.is_active agent_is_active
  FROM conversations c
  JOIN agent_configs a
    ON a.tenant_id = c.tenant_id
   AND (a.session_id = c.session_id OR a.session_id IS NULL)
  WHERE c.status = 'open' AND c.ai_active = true
  ORDER BY c.id, (a.session_id IS NOT NULL) DESC, a.updated_at DESC
)
UPDATE conversations c
SET ai_active = false,
    handoff_reason = 'agent_disabled'
FROM resolved_agent r
WHERE c.id = r.conversation_id
  AND c.status = 'open'
  AND c.ai_active = true
  AND r.agent_is_active = false;
