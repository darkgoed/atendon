-- Repair relationships that could have been invalidated by moving the referenced
-- row to another tenant before composite foreign keys existed.
UPDATE ai_stickers sticker
SET source_session_id=NULL,updated_at=now()
FROM whatsapp_sessions session
WHERE sticker.source_session_id=session.id
  AND sticker.tenant_id<>session.tenant_id;

UPDATE tenant_api_keys key
SET rotated_from_id=NULL,updated_at=now()
FROM tenant_api_keys previous
WHERE key.rotated_from_id=previous.id
  AND key.tenant_id<>previous.tenant_id;

DROP TRIGGER IF EXISTS ai_stickers_validate_source_tenant ON ai_stickers;
DROP FUNCTION IF EXISTS validate_ai_sticker_source_tenant();
DROP TRIGGER IF EXISTS tenant_api_keys_validate_rotation ON tenant_api_keys;
DROP FUNCTION IF EXISTS validate_tenant_api_key_rotation();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname='tenant_api_keys_id_tenant_unique'
  ) THEN
    ALTER TABLE tenant_api_keys
      ADD CONSTRAINT tenant_api_keys_id_tenant_unique UNIQUE(id,tenant_id);
  END IF;
END $$;

ALTER TABLE ai_stickers
  DROP CONSTRAINT IF EXISTS ai_stickers_source_session_id_fkey;
ALTER TABLE ai_stickers
  ADD CONSTRAINT ai_stickers_source_session_tenant_fkey
  FOREIGN KEY(source_session_id,tenant_id)
  REFERENCES whatsapp_sessions(id,tenant_id)
  ON DELETE SET NULL (source_session_id);

ALTER TABLE tenant_api_keys
  DROP CONSTRAINT IF EXISTS tenant_api_keys_rotated_from_id_fkey;
ALTER TABLE tenant_api_keys
  ADD CONSTRAINT tenant_api_keys_rotation_tenant_fkey
  FOREIGN KEY(rotated_from_id,tenant_id)
  REFERENCES tenant_api_keys(id,tenant_id)
  ON DELETE SET NULL (rotated_from_id);

-- Assignments created before 0063 could already point at inactive members. Move
-- them back to the human queue during the upgrade; the 0063 trigger normalizes
-- manually_paused into an actionable handoff reason when the assignee is cleared.
UPDATE conversations conversation
SET assigned_user_id=NULL,claimed_at=NULL
WHERE conversation.assigned_user_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM users assignee
    WHERE assignee.id=conversation.assigned_user_id
      AND assignee.status='active'
      AND assignee.is_root
  )
  AND NOT EXISTS (
    SELECT 1
    FROM workspace_members member
    JOIN users assignee ON assignee.id=member.user_id AND assignee.status='active'
    WHERE member.workspace_id=conversation.tenant_id
      AND member.user_id=conversation.assigned_user_id
      AND member.status='active'
  );

UPDATE scheduling_leads lead
SET assigned_member_id=NULL,updated_at=now()
WHERE lead.assigned_member_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM workspace_members member
    JOIN users assignee ON assignee.id=member.user_id AND assignee.status='active'
    WHERE member.id=lead.assigned_member_id
      AND member.workspace_id=lead.tenant_id
      AND member.status='active'
  );

CREATE OR REPLACE FUNCTION validate_conversation_assignee_tenant()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.assigned_user_id IS NULL THEN
    RETURN NEW;
  END IF;

  PERFORM 1
  FROM users assignee
  WHERE assignee.id=NEW.assigned_user_id
    AND assignee.status='active'
    AND assignee.is_root
  FOR KEY SHARE;
  IF FOUND THEN
    RETURN NEW;
  END IF;

  PERFORM 1
  FROM workspace_members member
  JOIN users assignee ON assignee.id=member.user_id
  WHERE member.workspace_id=NEW.tenant_id
    AND member.user_id=NEW.assigned_user_id
    AND member.status='active'
    AND assignee.status='active'
  FOR KEY SHARE OF member,assignee;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'conversation assignee is not active in this tenant';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION validate_scheduling_lead_assignee()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.assigned_member_id IS NULL THEN
    RETURN NEW;
  END IF;

  PERFORM 1
  FROM workspace_members member
  JOIN users assignee ON assignee.id=member.user_id
  WHERE member.id=NEW.assigned_member_id
    AND member.workspace_id=NEW.tenant_id
    AND member.status='active'
    AND assignee.status='active'
  FOR KEY SHARE OF member,assignee;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lead assignee is not active in this tenant';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER scheduling_leads_validate_active_assignee
BEFORE INSERT OR UPDATE OF tenant_id,assigned_member_id ON scheduling_leads
FOR EACH ROW EXECUTE FUNCTION validate_scheduling_lead_assignee();

CREATE OR REPLACE FUNCTION clear_inactive_user_assignments()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE conversations conversation
  SET assigned_user_id=NULL,claimed_at=NULL
  WHERE conversation.assigned_user_id=NEW.id
    AND (
      NEW.status<>'active'
      OR (
        NOT NEW.is_root
        AND NOT EXISTS (
          SELECT 1
          FROM workspace_members member
          WHERE member.workspace_id=conversation.tenant_id
            AND member.user_id=NEW.id
            AND member.status='active'
        )
      )
    );

  IF NEW.status<>'active' THEN
    UPDATE scheduling_leads lead
    SET assigned_member_id=NULL,updated_at=now()
    FROM workspace_members member
    WHERE lead.assigned_member_id=member.id
      AND lead.tenant_id=member.workspace_id
      AND member.user_id=NEW.id;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER users_clear_inactive_assignments
AFTER UPDATE OF status,is_root ON users
FOR EACH ROW
WHEN (OLD.status IS DISTINCT FROM NEW.status OR OLD.is_root IS DISTINCT FROM NEW.is_root)
EXECUTE FUNCTION clear_inactive_user_assignments();

-- PostgreSQL does not create indexes on the referencing side of foreign keys.
-- These cover parent updates/deletes without scanning entire tenant tables.
CREATE INDEX IF NOT EXISTS idx_conversations_session_tenant
  ON conversations(session_id,tenant_id) WHERE session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_conversations_assignee_tenant
  ON conversations(assigned_user_id,tenant_id) WHERE assigned_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_usage_logs_conversation_tenant
  ON usage_logs(conversation_id,tenant_id) WHERE conversation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_workspace_members_role_workspace
  ON workspace_members(role_id,workspace_id);
CREATE INDEX IF NOT EXISTS idx_workspace_invitations_role_workspace
  ON workspace_invitations(role_id,workspace_id);
CREATE INDEX IF NOT EXISTS idx_ai_stickers_source_session_tenant
  ON ai_stickers(source_session_id,tenant_id) WHERE source_session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ai_sticker_sends_conversation_tenant
  ON ai_sticker_sends(conversation_id,tenant_id);
CREATE INDEX IF NOT EXISTS idx_ai_sticker_sends_sticker_tenant
  ON ai_sticker_sends(sticker_id,tenant_id);
CREATE INDEX IF NOT EXISTS idx_scheduling_leads_assignee_tenant
  ON scheduling_leads(assigned_member_id,tenant_id) WHERE assigned_member_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tenant_api_keys_rotation_tenant
  ON tenant_api_keys(rotated_from_id,tenant_id) WHERE rotated_from_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_handoff_notifications_conversation_tenant
  ON handoff_notifications(conversation_id,tenant_id);
CREATE INDEX IF NOT EXISTS idx_handoff_notifications_session_tenant
  ON handoff_notifications(session_id,tenant_id);
CREATE INDEX IF NOT EXISTS idx_qualification_outbox_qualification_tenant
  ON qualification_message_outbox(qualification_id,tenant_id);
CREATE INDEX IF NOT EXISTS idx_qualification_outbox_session_tenant
  ON qualification_message_outbox(session_id,tenant_id);
