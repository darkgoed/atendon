CREATE TABLE IF NOT EXISTS feature_flag_definitions (
  flag_key TEXT PRIMARY KEY CHECK (flag_key IN (
    'conversations_delta_v2',
    'alerts_delivery_v2',
    'evaluation_event_enqueue_v2',
    'scheduling_meet_outbox_v2',
    'ai_deterministic_confirmations_v2',
    'evaluator_payload_redaction_v2',
    'state_tool_gating_v2',
    'compact_prompt_v2'
  )),
  description TEXT NOT NULL CHECK (char_length(description) BETWEEN 1 AND 500),
  default_enabled BOOLEAN NOT NULL DEFAULT false CHECK (default_enabled=false),
  global_enabled BOOLEAN,
  kill_switch_enabled BOOLEAN NOT NULL DEFAULT false,
  updated_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tenant_feature_flag_overrides (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  flag_key TEXT NOT NULL REFERENCES feature_flag_definitions(flag_key) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL,
  updated_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,flag_key)
);

CREATE INDEX IF NOT EXISTS idx_tenant_feature_flag_overrides_flag
  ON tenant_feature_flag_overrides(flag_key,tenant_id);

CREATE TABLE IF NOT EXISTS deployment_feature_flag_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deploy_version TEXT NOT NULL UNIQUE
    CHECK (deploy_version ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$'),
  latest_migration TEXT NOT NULL CHECK (latest_migration ~ '^[0-9]{4}_.+\.sql$'),
  global_flags JSONB NOT NULL CHECK (jsonb_typeof(global_flags)='object'),
  effective_flags JSONB NOT NULL CHECK (jsonb_typeof(effective_flags)='object'),
  snapshot_hash CHAR(64) NOT NULL CHECK (snapshot_hash ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_deployment_feature_flag_snapshots_created
  ON deployment_feature_flag_snapshots(created_at DESC);

CREATE OR REPLACE FUNCTION reject_deployment_feature_flag_snapshot_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'deployment feature flag snapshots are immutable'
    USING ERRCODE='55000';
END;
$$;

DROP TRIGGER IF EXISTS deployment_feature_flag_snapshots_immutable
  ON deployment_feature_flag_snapshots;
CREATE TRIGGER deployment_feature_flag_snapshots_immutable
BEFORE UPDATE OR DELETE ON deployment_feature_flag_snapshots
FOR EACH ROW
EXECUTE FUNCTION reject_deployment_feature_flag_snapshot_mutation();

INSERT INTO feature_flag_definitions(flag_key,description)
VALUES
  ('conversations_delta_v2','Paginação delta v2 de mensagens e conversas'),
  ('alerts_delivery_v2','Entrega de alertas por receipts e claim explícito'),
  ('evaluation_event_enqueue_v2','Enfileiramento v2 de eventos de avaliação'),
  ('scheduling_meet_outbox_v2','Provisionamento Google Meet via outbox'),
  ('ai_deterministic_confirmations_v2','Confirmações determinísticas após ferramentas'),
  ('evaluator_payload_redaction_v2','Redação de payloads enviados ao avaliador'),
  ('state_tool_gating_v2','Bloqueio de ferramentas conforme estado canônico'),
  ('compact_prompt_v2','Prompt compacto com contexto limitado')
ON CONFLICT(flag_key) DO NOTHING;
