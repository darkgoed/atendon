DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'whatsapp_sessions_id_tenant_unique'
  ) THEN
    ALTER TABLE whatsapp_sessions
      ADD CONSTRAINT whatsapp_sessions_id_tenant_unique UNIQUE (id, tenant_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'workspace_roles_id_workspace_unique'
  ) THEN
    ALTER TABLE workspace_roles
      ADD CONSTRAINT workspace_roles_id_workspace_unique UNIQUE (id, workspace_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ai_stickers_id_tenant_unique'
  ) THEN
    ALTER TABLE ai_stickers
      ADD CONSTRAINT ai_stickers_id_tenant_unique UNIQUE (id, tenant_id);
  END IF;
END $$;

ALTER TABLE conversations
  DROP CONSTRAINT IF EXISTS conversations_session_id_fkey;
ALTER TABLE conversations
  ADD CONSTRAINT conversations_session_tenant_fkey
  FOREIGN KEY (session_id, tenant_id)
  REFERENCES whatsapp_sessions(id, tenant_id);

ALTER TABLE usage_logs
  DROP CONSTRAINT IF EXISTS usage_logs_conversation_id_fkey;
ALTER TABLE usage_logs
  ADD CONSTRAINT usage_logs_conversation_tenant_fkey
  FOREIGN KEY (conversation_id, tenant_id)
  REFERENCES conversations(id, tenant_id);

ALTER TABLE workspace_members
  DROP CONSTRAINT IF EXISTS workspace_members_role_id_fkey;
ALTER TABLE workspace_members
  ADD CONSTRAINT workspace_members_role_workspace_fkey
  FOREIGN KEY (role_id, workspace_id)
  REFERENCES workspace_roles(id, workspace_id);

ALTER TABLE workspace_invitations
  DROP CONSTRAINT IF EXISTS workspace_invitations_role_id_fkey;
ALTER TABLE workspace_invitations
  ADD CONSTRAINT workspace_invitations_role_workspace_fkey
  FOREIGN KEY (role_id, workspace_id)
  REFERENCES workspace_roles(id, workspace_id);

ALTER TABLE ai_sticker_sends
  DROP CONSTRAINT IF EXISTS ai_sticker_sends_sticker_id_fkey;
ALTER TABLE ai_sticker_sends
  ADD CONSTRAINT ai_sticker_sends_sticker_tenant_fkey
  FOREIGN KEY (sticker_id, tenant_id)
  REFERENCES ai_stickers(id, tenant_id) ON DELETE CASCADE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM ai_stickers sticker
    JOIN whatsapp_sessions session ON session.id=sticker.source_session_id
    WHERE sticker.source_session_id IS NOT NULL
      AND session.tenant_id<>sticker.tenant_id
  ) THEN
    RAISE EXCEPTION 'existing sticker source session belongs to another tenant';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM tenant_api_keys key
    JOIN tenant_api_keys previous ON previous.id=key.rotated_from_id
    WHERE key.rotated_from_id IS NOT NULL
      AND previous.tenant_id<>key.tenant_id
  ) THEN
    RAISE EXCEPTION 'existing API key rotation belongs to another tenant';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION validate_ai_sticker_source_tenant()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.source_session_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM whatsapp_sessions
    WHERE id=NEW.source_session_id AND tenant_id=NEW.tenant_id
  ) THEN
    RAISE EXCEPTION 'sticker source session belongs to another tenant';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER ai_stickers_validate_source_tenant
BEFORE INSERT OR UPDATE OF tenant_id,source_session_id ON ai_stickers
FOR EACH ROW EXECUTE FUNCTION validate_ai_sticker_source_tenant();

CREATE OR REPLACE FUNCTION validate_tenant_api_key_rotation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.rotated_from_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM tenant_api_keys
    WHERE id=NEW.rotated_from_id AND tenant_id=NEW.tenant_id
  ) THEN
    RAISE EXCEPTION 'API key rotation belongs to another tenant';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER tenant_api_keys_validate_rotation
BEFORE INSERT OR UPDATE OF tenant_id,rotated_from_id ON tenant_api_keys
FOR EACH ROW EXECUTE FUNCTION validate_tenant_api_key_rotation();
