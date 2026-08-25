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

INSERT INTO feature_flag_definitions(flag_key,description,global_enabled)
VALUES ('web_push_v1','PWA instalável e entrega discreta por Web Push',true)
ON CONFLICT(flag_key) DO UPDATE SET
  description=EXCLUDED.description,
  global_enabled=COALESCE(feature_flag_definitions.global_enabled,EXCLUDED.global_enabled),
  updated_at=now();

DELETE FROM tenant_feature_flag_overrides
WHERE flag_key IN ('case_organization_v1','dashboard_widgets_v1','web_push_v1');

ALTER TABLE panel_notification_preferences
  ADD COLUMN IF NOT EXISTS web_push_enabled BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS push_assigned_messages BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS push_assignments BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS push_appointments BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS push_critical_alerts BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS push_other BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE web_push_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL CHECK (char_length(endpoint) BETWEEN 12 AND 4096),
  p256dh TEXT NOT NULL CHECK (char_length(p256dh) BETWEEN 16 AND 512),
  auth TEXT NOT NULL CHECK (char_length(auth) BETWEEN 8 AND 512),
  expiration_time BIGINT,
  device_name TEXT NOT NULL DEFAULT 'Dispositivo' CHECK (char_length(device_name) BETWEEN 1 AND 120),
  user_agent TEXT CHECK (user_agent IS NULL OR char_length(user_agent) <= 500),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_success_at TIMESTAMPTZ,
  UNIQUE (tenant_id,user_id,endpoint),
  CONSTRAINT web_push_subscriptions_endpoint_https_check
    CHECK (endpoint ~ '^https://')
);

CREATE INDEX idx_web_push_subscriptions_user
  ON web_push_subscriptions(tenant_id,user_id,updated_at DESC);

CREATE TABLE web_push_outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'assigned_message','case_assignment','handoff','appointment_changed',
    'appointment_reminder','critical_alert','other'
  )),
  urgency TEXT NOT NULL DEFAULT 'normal' CHECK (urgency IN ('low','normal','high','critical')),
  target_path TEXT NOT NULL CHECK (
    char_length(target_path) BETWEEN 1 AND 500
    AND target_path LIKE '/%'
    AND target_path NOT LIKE '//%'
  ),
  resource_type TEXT NOT NULL CHECK (char_length(resource_type) BETWEEN 1 AND 80),
  resource_id UUID,
  dedupe_key TEXT NOT NULL CHECK (char_length(dedupe_key) BETWEEN 1 AND 300),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','sent','failed')),
  attempt_count INT NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processing_started_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at TIMESTAMPTZ,
  UNIQUE (tenant_id,user_id,dedupe_key),
  CONSTRAINT web_push_outbox_id_tenant_unique UNIQUE (id,tenant_id)
);

CREATE INDEX idx_web_push_outbox_pending
  ON web_push_outbox(available_at,created_at,id)
  WHERE status='pending';

CREATE TABLE web_push_deliveries (
  outbox_id UUID NOT NULL,
  tenant_id UUID NOT NULL,
  subscription_id UUID NOT NULL REFERENCES web_push_subscriptions(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed')),
  attempt_count INT NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error TEXT,
  sent_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (outbox_id,subscription_id),
  CONSTRAINT web_push_deliveries_outbox_tenant_fkey
    FOREIGN KEY (outbox_id,tenant_id) REFERENCES web_push_outbox(id,tenant_id) ON DELETE CASCADE
);

CREATE INDEX idx_web_push_deliveries_pending
  ON web_push_deliveries(outbox_id,status,updated_at);

CREATE OR REPLACE FUNCTION web_push_effective_enabled(workspace_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE((
    SELECT CASE
      WHEN definition.kill_switch_enabled THEN false
      ELSE COALESCE(definition.global_enabled,definition.default_enabled)
    END
    FROM feature_flag_definitions definition
    WHERE definition.flag_key='web_push_v1'
  ),false)
$$;

CREATE OR REPLACE FUNCTION enqueue_web_push_notification(
  workspace_id UUID,
  recipient_user_id UUID,
  notification_event_type TEXT,
  notification_urgency TEXT,
  notification_target_path TEXT,
  notification_resource_type TEXT,
  notification_resource_id UUID,
  notification_dedupe_key TEXT
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  preference_enabled BOOLEAN;
BEGIN
  IF recipient_user_id IS NULL OR NOT web_push_effective_enabled(workspace_id) THEN
    RETURN;
  END IF;

  SELECT COALESCE(preference.web_push_enabled,true) AND CASE notification_event_type
    WHEN 'assigned_message' THEN COALESCE(preference.push_assigned_messages,true)
    WHEN 'case_assignment' THEN COALESCE(preference.push_assignments,true)
    WHEN 'handoff' THEN COALESCE(preference.push_assignments,true)
    WHEN 'appointment_changed' THEN COALESCE(preference.push_appointments,true)
    WHEN 'appointment_reminder' THEN COALESCE(preference.push_appointments,true)
    WHEN 'critical_alert' THEN COALESCE(preference.push_critical_alerts,true)
    ELSE COALESCE(preference.push_other,false)
  END
  INTO preference_enabled
  FROM (SELECT 1) seed
  LEFT JOIN panel_notification_preferences preference
    ON preference.tenant_id=workspace_id AND preference.user_id=recipient_user_id;

  IF NOT COALESCE(preference_enabled,false) THEN
    RETURN;
  END IF;

  INSERT INTO web_push_outbox(
    tenant_id,user_id,event_type,urgency,target_path,resource_type,resource_id,dedupe_key
  ) VALUES (
    workspace_id,recipient_user_id,notification_event_type,notification_urgency,
    notification_target_path,notification_resource_type,notification_resource_id,notification_dedupe_key
  ) ON CONFLICT(tenant_id,user_id,dedupe_key) DO NOTHING;
END;
$$;

CREATE OR REPLACE FUNCTION enqueue_assigned_message_web_push()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  conversation_record RECORD;
BEGIN
  IF NEW.sender <> 'contact' THEN RETURN NEW; END IF;
  SELECT conversation.tenant_id,conversation.assigned_user_id
  INTO conversation_record
  FROM conversations conversation
  WHERE conversation.id=NEW.conversation_id;

  IF conversation_record.assigned_user_id IS NOT NULL THEN
    PERFORM enqueue_web_push_notification(
      conversation_record.tenant_id,conversation_record.assigned_user_id,
      'assigned_message','normal','/conversas?id=' || NEW.conversation_id,
      'conversation',NEW.conversation_id,'assigned-message:' || NEW.id
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS messages_enqueue_assigned_web_push ON messages;
CREATE TRIGGER messages_enqueue_assigned_web_push
AFTER INSERT ON messages
FOR EACH ROW EXECUTE FUNCTION enqueue_assigned_message_web_push();

CREATE OR REPLACE FUNCTION enqueue_conversation_assignment_web_push()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.assigned_user_id IS NOT NULL
    AND NEW.assigned_user_id IS DISTINCT FROM OLD.assigned_user_id THEN
    PERFORM enqueue_web_push_notification(
      NEW.tenant_id,NEW.assigned_user_id,'case_assignment','high',
      '/conversas?id=' || NEW.id,'conversation',NEW.id,
      'case-assignment:' || NEW.id || ':' || txid_current()
    );
  END IF;
  IF NEW.assigned_user_id IS NOT NULL
    AND (NEW.handoff_reason IS DISTINCT FROM OLD.handoff_reason OR NEW.ai_active IS DISTINCT FROM OLD.ai_active)
    AND NEW.ai_active=false THEN
    PERFORM enqueue_web_push_notification(
      NEW.tenant_id,NEW.assigned_user_id,'handoff','high',
      '/conversas?id=' || NEW.id,'conversation',NEW.id,
      'handoff:' || NEW.id || ':' || txid_current()
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS conversations_enqueue_assignment_web_push ON conversations;
CREATE TRIGGER conversations_enqueue_assignment_web_push
AFTER UPDATE OF assigned_user_id,handoff_reason,ai_active ON conversations
FOR EACH ROW EXECUTE FUNCTION enqueue_conversation_assignment_web_push();

CREATE OR REPLACE FUNCTION enqueue_appointment_web_push()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  recipient_user_id UUID;
  workspace_timezone TEXT;
BEGIN
  IF NEW.assigned_member_id IS NULL THEN RETURN NEW; END IF;
  SELECT member.user_id INTO recipient_user_id
  FROM workspace_members member
  WHERE member.workspace_id=NEW.tenant_id AND member.id=NEW.assigned_member_id AND member.status='active';
  IF recipient_user_id IS NULL THEN RETURN NEW; END IF;
  SELECT tenant.timezone INTO workspace_timezone FROM tenants tenant WHERE tenant.id=NEW.tenant_id;

  IF TG_OP='INSERT'
    OR NEW.status IS DISTINCT FROM OLD.status
    OR NEW.start_at IS DISTINCT FROM OLD.start_at
    OR NEW.assigned_member_id IS DISTINCT FROM OLD.assigned_member_id THEN
    PERFORM enqueue_web_push_notification(
      NEW.tenant_id,recipient_user_id,'appointment_changed','high',
      '/agenda?appointment=' || NEW.id || '&unit=' || NEW.unit_id || '&date=' ||
        to_char(NEW.start_at AT TIME ZONE COALESCE(workspace_timezone,'UTC'),'YYYY-MM-DD'),
      'appointment',NEW.id,
      'appointment-change:' || NEW.id || ':' || txid_current()
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS scheduling_appointments_enqueue_web_push ON scheduling_appointments;
CREATE TRIGGER scheduling_appointments_enqueue_web_push
AFTER INSERT OR UPDATE OF status,start_at,assigned_member_id ON scheduling_appointments
FOR EACH ROW EXECUTE FUNCTION enqueue_appointment_web_push();

CREATE OR REPLACE FUNCTION enqueue_critical_alert_web_push()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  recipient RECORD;
BEGIN
  FOR recipient IN
    SELECT DISTINCT member.user_id
    FROM workspace_members member
    WHERE member.workspace_id=NEW.tenant_id AND member.status='active'
  LOOP
    PERFORM enqueue_web_push_notification(
      NEW.tenant_id,recipient.user_id,'critical_alert','critical',
      '/alertas','system_alert',NEW.id,'critical-alert:' || NEW.id
    );
  END LOOP;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS system_alerts_enqueue_web_push ON system_alerts;
CREATE TRIGGER system_alerts_enqueue_web_push
AFTER INSERT ON system_alerts
FOR EACH ROW EXECUTE FUNCTION enqueue_critical_alert_web_push();
