-- SPEC v7 (specs/active/v7-port-crm-whatsapp.md, ONDA 3/C1):
-- (a) flow_versions — snapshot JSONB por salvamento/restauração de fluxo de robô,
--     com diff (nós/conexões) e restore por permissão do fluxo;
-- (b) flow_templates — snapshots nomeados por tenant (salvar/carregar definição);
-- (c) qualification_flows.allowed_role_ids — restrição opcional de execução por
--     papel do responsável do lead (gating no executor; vazio = sem restrição);
-- (d) nós interactive saem pela outbox como message_kind 'interactive' com
--     payload estruturado (botões até 3 / list máx 10 / cta_url).
-- Aditiva e idempotente. Sem dados novos além de defaults.
-- ROLLBACK (manual, não executar automaticamente):
-- DROP TABLE IF EXISTS flow_templates;
-- DROP TABLE IF EXISTS flow_versions;
-- ALTER TABLE qualification_flows DROP COLUMN IF EXISTS allowed_role_ids;
-- ALTER TABLE qualification_message_outbox DROP COLUMN IF EXISTS interactive_payload;
-- ALTER TABLE qualification_message_outbox DROP CONSTRAINT IF EXISTS qualification_message_outbox_message_kind_check;
-- ALTER TABLE qualification_message_outbox ADD CONSTRAINT qualification_message_outbox_message_kind_check CHECK (message_kind IN ('question','clarification','confirmation','final','message'));

CREATE TABLE IF NOT EXISTS flow_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  flow_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  definition JSONB NOT NULL,
  flow_name TEXT NOT NULL,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, flow_id, version),
  FOREIGN KEY (tenant_id, flow_id) REFERENCES qualification_flows(tenant_id, id) ON DELETE CASCADE
);

-- Listagem de versões (mais recente primeiro) e resolução de uma versão.
CREATE INDEX IF NOT EXISTS idx_flow_versions_flow
  ON flow_versions(tenant_id, flow_id, version DESC);

CREATE TABLE IF NOT EXISTS flow_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  definition JSONB NOT NULL,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

ALTER TABLE qualification_flows
  ADD COLUMN IF NOT EXISTS allowed_role_ids UUID[] NOT NULL DEFAULT '{}';

-- Mensagens interativas (nó interactive) carregam o payload estruturado que o
-- gateway opcional sendInteractive consome; o texto legível segue na coluna
-- message (histórico da conversa).
ALTER TABLE qualification_message_outbox
  ADD COLUMN IF NOT EXISTS interactive_payload JSONB;

ALTER TABLE qualification_message_outbox
  DROP CONSTRAINT IF EXISTS qualification_message_outbox_message_kind_check;
ALTER TABLE qualification_message_outbox
  ADD CONSTRAINT qualification_message_outbox_message_kind_check
  CHECK (message_kind IN ('question','clarification','confirmation','final','message','interactive'));
