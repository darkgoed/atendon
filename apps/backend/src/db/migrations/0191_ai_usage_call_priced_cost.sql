-- Consumo de IA por CHAMADA: valor estimado USD micros por chamada sem custo
-- reportado; NULL significa ainda não estimado (aditivo, idempotente).
ALTER TABLE usage_logs
  ADD COLUMN IF NOT EXISTS priced_cost_usd_micros BIGINT
    CHECK (priced_cost_usd_micros >= 0);
