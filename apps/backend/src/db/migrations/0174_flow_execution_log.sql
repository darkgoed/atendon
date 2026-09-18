-- R22 (specs/active/v6-evolucao-estrutural-atendon.md): histórico de execução dos
-- fluxos de robô determinísticos. Append-only; o executor grava entered/completed/
-- failed/waiting/skipped por etapa visitada. Retenção: 90 dias (limpeza no worker).
-- Aditiva e idempotente.
-- ROLLBACK (manual, não executar automaticamente):
-- DROP TABLE IF EXISTS flow_execution_log;

CREATE TABLE IF NOT EXISTS flow_execution_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  flow_id TEXT NOT NULL,
  conversation_id UUID,
  lead_id UUID,
  node_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('entered','completed','failed','waiting','skipped')),
  detail JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, flow_id) REFERENCES qualification_flows(tenant_id, id) ON DELETE CASCADE
);

-- Paginação keyset por fluxo (GET /qualification/flows/:id/executions).
CREATE INDEX IF NOT EXISTS idx_flow_execution_log_flow
  ON flow_execution_log(tenant_id, flow_id, created_at DESC, id DESC);

-- Histórico por conversa (R9/R22: "como entrou → o que aconteceu").
CREATE INDEX IF NOT EXISTS idx_flow_execution_log_conversation
  ON flow_execution_log(tenant_id, conversation_id, created_at DESC, id DESC);

-- Limpeza de retenção: DELETE único por created_at (worker, 90 dias).
-- Predicado parcial não é possível aqui: índices não podem usar now() (mutável).
CREATE INDEX IF NOT EXISTS idx_flow_execution_log_retention
  ON flow_execution_log(created_at);
