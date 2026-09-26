-- Procedência do custo de IA em usage_logs: distingue custo REPORTADO pelo
-- provedor (mesmo 0 = zero real, do payload usage.cost) de custo AUSENTE
-- (fallback `?? 0`, único caminho antigo da coluna cost_usd). Histórico fica
-- reportado: o 0 ambíguo legado nunca gera cobrança inventada, sem retrocobrança.
ALTER TABLE usage_logs
  ADD COLUMN IF NOT EXISTS cost_reported BOOLEAN NOT NULL DEFAULT TRUE;
