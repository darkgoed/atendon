ALTER TABLE feature_flag_definitions
  DROP CONSTRAINT IF EXISTS feature_flag_definitions_flag_key_check;
ALTER TABLE feature_flag_definitions
  ADD CONSTRAINT feature_flag_definitions_flag_key_check CHECK (flag_key IN (
    'ai_turn_visibility_v1',
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
  'ai_turn_visibility_v1',
  'Andamento operacional e prévia efêmera dos turnos da IA',
  false,
  null,
  false
)
ON CONFLICT(flag_key) DO UPDATE SET
  description=EXCLUDED.description,
  updated_at=now();
