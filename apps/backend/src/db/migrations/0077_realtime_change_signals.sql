CREATE OR REPLACE FUNCTION notify_realtime_message_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  workspace_id uuid;
BEGIN
  SELECT tenant_id INTO workspace_id
  FROM conversations
  WHERE id=NEW.conversation_id;

  IF workspace_id IS NOT NULL THEN
    PERFORM pg_notify(
      'atendon_realtime_changes',
      json_build_object(
        'v',1,
        'type','conversation.messages.changed',
        'tenantId',workspace_id,
        'conversationId',NEW.conversation_id,
        'entityId',NEW.id
      )::text
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS messages_notify_realtime_insert ON messages;
CREATE TRIGGER messages_notify_realtime_insert
AFTER INSERT ON messages
FOR EACH ROW
EXECUTE FUNCTION notify_realtime_message_insert();

CREATE OR REPLACE FUNCTION notify_realtime_alert_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM pg_notify(
    'atendon_realtime_changes',
    json_build_object(
      'v',1,
      'type','alerts.changed',
      'tenantId',NEW.tenant_id,
      'entityId',NEW.id
    )::text
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS system_alerts_notify_realtime_insert ON system_alerts;
CREATE TRIGGER system_alerts_notify_realtime_insert
AFTER INSERT ON system_alerts
FOR EACH ROW
EXECUTE FUNCTION notify_realtime_alert_insert();
