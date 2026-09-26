-- Preço de IA por PAR (provider, model) + provider REAL de cada chamada.
-- Aditivo e compatível: linhas existentes de ai_model_prices ficam com
-- provider NULL = preço genérico do modelo (fallback quando não há preço
-- específico do provider). usage_logs.provider NULL = provider desconhecido
-- (histórico ou payload sem o campo) → cai no preço genérico do modelo.
-- Nome do provider é o reportado pelo OpenRouter no campo `provider` da
-- resposta, normalizado em lower(trim()) na escrita e na busca.
ALTER TABLE ai_model_prices ADD COLUMN IF NOT EXISTS provider TEXT;
ALTER TABLE ai_model_prices DROP CONSTRAINT IF EXISTS ai_model_prices_provider_normalized;
ALTER TABLE ai_model_prices ADD CONSTRAINT ai_model_prices_provider_normalized
  CHECK (provider IS NULL OR (provider = lower(btrim(provider)) AND provider <> ''));
DROP INDEX IF EXISTS idx_ai_model_prices_model_effective;
CREATE INDEX IF NOT EXISTS idx_ai_model_prices_model_provider_effective
  ON ai_model_prices(model, provider, effective_from DESC);

ALTER TABLE usage_logs ADD COLUMN IF NOT EXISTS provider TEXT;
ALTER TABLE usage_logs DROP CONSTRAINT IF EXISTS usage_logs_provider_normalized;
ALTER TABLE usage_logs ADD CONSTRAINT usage_logs_provider_normalized
  CHECK (provider IS NULL OR (provider = lower(btrim(provider)) AND provider <> '')) NOT VALID;
-- Coluna nova (todas as linhas NULL): validar é trivial e evita constraint
-- inválida — a verificação de backup/restore exige zero constraints NOT VALID.
ALTER TABLE usage_logs VALIDATE CONSTRAINT usage_logs_provider_normalized;
