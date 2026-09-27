-- Período de uso FECHADO fora do reconciliador (ex.: reserva de IA chamando
-- ensureOpenPeriod na virada do mês) precisa voltar a ser candidato ao
-- faturamento. `billing_evaluated_at` marca o período que o faturamento já
-- avaliou (com ou sem fatura), para que períodos sem nada a cobrar não sejam
-- reavaliados a cada minuto nem monopolizem o LIMIT do lote.
--
-- Idempotente e conservador com dados existentes: períodos já fechados antes
-- desta migration são marcados como avaliados, preservando o comportamento
-- atual para eles (nenhuma cobrança retroativa em massa no deploy).
ALTER TABLE usage_periods ADD COLUMN IF NOT EXISTS billing_evaluated_at TIMESTAMPTZ;

UPDATE usage_periods
   SET billing_evaluated_at = COALESCE(closed_at, now())
 WHERE status IN ('CLOSED', 'INVOICED') AND billing_evaluated_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_usage_periods_closed_unevaluated
  ON usage_periods(tenant_id)
  WHERE status = 'CLOSED' AND billing_evaluated_at IS NULL;
