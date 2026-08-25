ALTER TABLE feature_flag_definitions
  DROP CONSTRAINT IF EXISTS feature_flag_definitions_flag_key_check;

ALTER TABLE feature_flag_definitions
  ADD CONSTRAINT feature_flag_definitions_flag_key_check CHECK (flag_key IN (
    'conversations_delta_v2',
    'alerts_delivery_v2',
    'evaluation_event_enqueue_v2',
    'scheduling_meet_outbox_v2',
    'ai_deterministic_confirmations_v2',
    'evaluator_payload_redaction_v2',
    'state_tool_gating_v2',
    'compact_prompt_v2',
    'case_organization_v1',
    'dashboard_widgets_v1',
    'web_push_v1'
  ));

INSERT INTO feature_flag_definitions(
  flag_key,description,default_enabled,global_enabled,kill_switch_enabled
) VALUES (
  'dashboard_widgets_v1',
  'Dashboard responsivo com widgets e layout pessoal por workspace',
  false,
  true,
  false
)
ON CONFLICT(flag_key) DO UPDATE SET description=EXCLUDED.description;

CREATE TABLE IF NOT EXISTS dashboard_layouts (
  workspace_id UUID NOT NULL,
  user_id UUID NOT NULL,
  items JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,user_id),
  FOREIGN KEY(workspace_id,user_id)
    REFERENCES workspace_members(workspace_id,user_id)
    ON DELETE CASCADE,
  CHECK (jsonb_typeof(items)='array'),
  CHECK (CASE WHEN jsonb_typeof(items)='array' THEN jsonb_array_length(items) <= 20 ELSE false END)
);

CREATE INDEX IF NOT EXISTS idx_dashboard_layouts_user
  ON dashboard_layouts(user_id,updated_at DESC);
