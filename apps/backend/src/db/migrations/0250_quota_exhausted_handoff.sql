-- Motivo de pausa `quota_exhausted`: a franquia/créditos de IA do tenant
-- acabou e o consumo foi negado (QUOTA_EXCEEDED/CREDIT_CAP_REACHED). Estado
-- explícito e observável no inbox — a IA nunca fica marcada como ativa e
-- silenciosa. Idempotente: DROP/ADD CONSTRAINT.
ALTER TABLE conversations
  DROP CONSTRAINT IF EXISTS conversations_handoff_reason_check;
ALTER TABLE conversations
  ADD CONSTRAINT conversations_handoff_reason_check CHECK (
    handoff_reason IS NULL OR handoff_reason IN (
      'ai_decided','contact_requested','manually_paused','technical_failure',
      'commercial_handoff','agent_disabled','quota_exhausted'
    )
  );
