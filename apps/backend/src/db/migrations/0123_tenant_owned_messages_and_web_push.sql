DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM messages message
    JOIN messages replied ON replied.id=message.reply_to_message_id
    WHERE message.reply_to_message_id IS NOT NULL
      AND replied.conversation_id<>message.conversation_id
  ) THEN
    RAISE EXCEPTION
      'Cannot enforce message reply integrity: a reply target belongs to another conversation';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM web_push_deliveries delivery
    JOIN web_push_subscriptions subscription ON subscription.id=delivery.subscription_id
    WHERE subscription.tenant_id<>delivery.tenant_id
  ) THEN
    RAISE EXCEPTION
      'Cannot enforce Web Push tenant integrity: a delivery references another tenant subscription';
  END IF;
END $$;

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS tenant_id UUID;

UPDATE messages message
SET tenant_id=conversation.tenant_id
FROM conversations conversation
WHERE conversation.id=message.conversation_id
  AND message.tenant_id IS NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM messages message
    JOIN conversations conversation ON conversation.id=message.conversation_id
    WHERE message.tenant_id IS NOT NULL
      AND message.tenant_id<>conversation.tenant_id
  ) THEN
    RAISE EXCEPTION
      'Cannot enforce message tenant ownership: a message tenant differs from its conversation';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM messages message
    JOIN agent_config_versions version ON version.id=message.agent_config_version_id
    WHERE message.agent_config_version_id IS NOT NULL
      AND message.tenant_id<>version.tenant_id
  ) THEN
    RAISE EXCEPTION
      'Cannot enforce message agent configuration ownership: a version belongs to another tenant';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM ai_follow_up_schedules follow_up
    JOIN messages message ON message.id=follow_up.last_agent_message_id
    WHERE message.conversation_id<>follow_up.conversation_id
  ) THEN
    RAISE EXCEPTION
      'Cannot enforce AI follow-up message ownership: a message belongs to another conversation';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM usage_logs usage
    JOIN messages message ON message.id=usage.message_id
    WHERE usage.message_id IS NOT NULL
      AND (
        message.tenant_id<>usage.tenant_id
        OR (
          usage.conversation_id IS NOT NULL
          AND message.conversation_id<>usage.conversation_id
        )
      )
  ) THEN
    RAISE EXCEPTION
      'Cannot enforce AI usage message ownership: a message belongs to another tenant or conversation';
  END IF;
END $$;

ALTER TABLE messages
  ALTER COLUMN tenant_id SET NOT NULL;

CREATE OR REPLACE FUNCTION enforce_message_tenant_ownership()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  conversation_tenant_id UUID;
BEGIN
  SELECT tenant_id INTO conversation_tenant_id
  FROM conversations
  WHERE id=NEW.conversation_id;

  IF conversation_tenant_id IS NULL THEN
    RAISE EXCEPTION 'message conversation does not exist';
  END IF;

  IF TG_OP='UPDATE' AND NEW.tenant_id IS DISTINCT FROM OLD.tenant_id THEN
    RAISE EXCEPTION 'message tenant ownership is immutable';
  END IF;

  IF NEW.tenant_id IS NULL THEN
    NEW.tenant_id=conversation_tenant_id;
  ELSIF NEW.tenant_id<>conversation_tenant_id THEN
    RAISE EXCEPTION 'message conversation belongs to another tenant';
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS messages_enforce_tenant_ownership ON messages;
CREATE TRIGGER messages_enforce_tenant_ownership
BEFORE INSERT OR UPDATE OF tenant_id,conversation_id ON messages
FOR EACH ROW EXECUTE FUNCTION enforce_message_tenant_ownership();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname='messages_id_tenant_unique'
  ) THEN
    ALTER TABLE messages
      ADD CONSTRAINT messages_id_tenant_unique UNIQUE(id,tenant_id);
  END IF;
END $$;

ALTER TABLE messages
  DROP CONSTRAINT IF EXISTS messages_conversation_id_fkey;
ALTER TABLE messages
  ADD CONSTRAINT messages_conversation_tenant_fkey
  FOREIGN KEY(conversation_id,tenant_id)
  REFERENCES conversations(id,tenant_id)
  ON DELETE CASCADE;

ALTER TABLE messages
  DROP CONSTRAINT IF EXISTS messages_reply_to_message_id_fkey;
ALTER TABLE messages
  ADD CONSTRAINT messages_reply_same_conversation_fkey
  FOREIGN KEY(reply_to_message_id,conversation_id)
  REFERENCES messages(id,conversation_id)
  ON DELETE SET NULL (reply_to_message_id);

ALTER TABLE messages
  DROP CONSTRAINT IF EXISTS messages_agent_config_version_id_fkey;
ALTER TABLE messages
  ADD CONSTRAINT messages_agent_config_version_tenant_fkey
  FOREIGN KEY(agent_config_version_id,tenant_id)
  REFERENCES agent_config_versions(id,tenant_id)
  ON DELETE SET NULL (agent_config_version_id);

ALTER TABLE ai_follow_up_schedules
  DROP CONSTRAINT IF EXISTS ai_follow_up_schedules_last_agent_message_id_fkey;
ALTER TABLE ai_follow_up_schedules
  ADD CONSTRAINT ai_follow_up_message_conversation_fkey
  FOREIGN KEY(last_agent_message_id,conversation_id)
  REFERENCES messages(id,conversation_id)
  ON DELETE CASCADE;

ALTER TABLE usage_logs
  DROP CONSTRAINT IF EXISTS usage_logs_message_id_fkey;
ALTER TABLE usage_logs
  ADD CONSTRAINT usage_logs_message_tenant_fkey
  FOREIGN KEY(message_id,tenant_id)
  REFERENCES messages(id,tenant_id)
  ON DELETE SET NULL (message_id);
ALTER TABLE usage_logs
  ADD CONSTRAINT usage_logs_message_conversation_fkey
  FOREIGN KEY(message_id,conversation_id)
  REFERENCES messages(id,conversation_id)
  ON DELETE SET NULL (message_id);

CREATE INDEX IF NOT EXISTS idx_ai_follow_up_schedules_message_conversation
  ON ai_follow_up_schedules(last_agent_message_id,conversation_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname='web_push_subscriptions_id_tenant_unique'
  ) THEN
    ALTER TABLE web_push_subscriptions
      ADD CONSTRAINT web_push_subscriptions_id_tenant_unique UNIQUE(id,tenant_id);
  END IF;
END $$;

ALTER TABLE web_push_deliveries
  DROP CONSTRAINT IF EXISTS web_push_deliveries_subscription_id_fkey;
ALTER TABLE web_push_deliveries
  ADD CONSTRAINT web_push_deliveries_subscription_tenant_fkey
  FOREIGN KEY(subscription_id,tenant_id)
  REFERENCES web_push_subscriptions(id,tenant_id)
  ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_web_push_deliveries_subscription_tenant
  ON web_push_deliveries(subscription_id,tenant_id);

CREATE OR REPLACE FUNCTION web_push_recipient_active(
  target_workspace_id UUID,
  target_user_id UUID
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM users recipient
    WHERE recipient.id=target_user_id
      AND recipient.status='active'
      AND (
        recipient.is_root
        OR EXISTS (
          SELECT 1
          FROM workspace_members member
          WHERE member.workspace_id=target_workspace_id
            AND member.user_id=target_user_id
            AND member.status='active'
        )
      )
  )
$$;

DELETE FROM web_push_subscriptions subscription
WHERE NOT web_push_recipient_active(subscription.tenant_id,subscription.user_id);

UPDATE web_push_outbox outbox
SET status='sent',processing_started_at=NULL,sent_at=now(),
    last_error='suppressed_by_membership',updated_at=now()
WHERE outbox.status IN ('pending','processing')
  AND NOT web_push_recipient_active(outbox.tenant_id,outbox.user_id);

CREATE OR REPLACE FUNCTION suppress_revoked_web_push_access()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  revoked_workspace_id UUID;
  revoked_user_id UUID;
BEGIN
  revoked_workspace_id=OLD.workspace_id;
  revoked_user_id=OLD.user_id;

  IF TG_OP='UPDATE'
    AND OLD.workspace_id IS NOT DISTINCT FROM NEW.workspace_id
    AND OLD.user_id IS NOT DISTINCT FROM NEW.user_id
    AND OLD.status IS NOT DISTINCT FROM NEW.status THEN
    RETURN NEW;
  END IF;

  IF web_push_recipient_active(revoked_workspace_id,revoked_user_id) THEN
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  DELETE FROM web_push_subscriptions
  WHERE tenant_id=revoked_workspace_id AND user_id=revoked_user_id;

  UPDATE web_push_outbox
  SET status='sent',processing_started_at=NULL,sent_at=now(),
      last_error='suppressed_by_membership',updated_at=now()
  WHERE tenant_id=revoked_workspace_id AND user_id=revoked_user_id
    AND status IN ('pending','processing');

  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS workspace_members_suppress_revoked_web_push ON workspace_members;
CREATE TRIGGER workspace_members_suppress_revoked_web_push
AFTER DELETE OR UPDATE OF workspace_id,user_id,status ON workspace_members
FOR EACH ROW EXECUTE FUNCTION suppress_revoked_web_push_access();

CREATE OR REPLACE FUNCTION suppress_inactive_user_web_push_access()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status='active' AND NEW.is_root IS NOT DISTINCT FROM OLD.is_root THEN
    RETURN NEW;
  END IF;

  DELETE FROM web_push_subscriptions subscription
  WHERE subscription.user_id=NEW.id
    AND NOT web_push_recipient_active(subscription.tenant_id,NEW.id);

  UPDATE web_push_outbox outbox
  SET status='sent',processing_started_at=NULL,sent_at=now(),
      last_error='suppressed_by_membership',updated_at=now()
  WHERE outbox.user_id=NEW.id
    AND outbox.status IN ('pending','processing')
    AND NOT web_push_recipient_active(outbox.tenant_id,NEW.id);

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS users_suppress_inactive_web_push ON users;
CREATE TRIGGER users_suppress_inactive_web_push
AFTER UPDATE OF status,is_root ON users
FOR EACH ROW
WHEN (OLD.status IS DISTINCT FROM NEW.status OR OLD.is_root IS DISTINCT FROM NEW.is_root)
EXECUTE FUNCTION suppress_inactive_user_web_push_access();

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
  IF recipient_user_id IS NULL
    OR NOT web_push_effective_enabled(workspace_id)
    OR NOT web_push_recipient_active(workspace_id,recipient_user_id) THEN
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
