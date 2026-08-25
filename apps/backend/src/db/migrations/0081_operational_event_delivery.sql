CREATE TABLE ai_evaluation_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL,
  agent_config_version_id UUID NOT NULL,
  trigger TEXT NOT NULL CHECK (trigger IN ('closed','handoff','tool_error','sampled')),
  rubric_version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','completed')),
  enqueue_attempts INTEGER NOT NULL DEFAULT 0 CHECK (enqueue_attempts >= 0),
  last_enqueued_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (conversation_id,tenant_id)
    REFERENCES conversations(id,tenant_id) ON DELETE CASCADE,
  FOREIGN KEY (agent_config_version_id,tenant_id)
    REFERENCES agent_config_versions(id,tenant_id),
  UNIQUE (conversation_id,agent_config_version_id,rubric_version,trigger)
);

CREATE INDEX idx_ai_evaluation_events_pending_keyset
  ON ai_evaluation_events(created_at,id)
  WHERE status='pending';

CREATE INDEX idx_handoff_notifications_pending_keyset
  ON handoff_notifications(created_at,id)
  WHERE status='pending';

CREATE INDEX idx_ai_follow_up_schedules_due_keyset
  ON ai_follow_up_schedules(next_run_at,conversation_id)
  WHERE status='scheduled';

CREATE INDEX idx_ai_follow_up_schedules_stale_keyset
  ON ai_follow_up_schedules(processing_started_at,conversation_id)
  WHERE status='processing';
