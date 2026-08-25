DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM conversations conversation
    JOIN users assignee ON assignee.id=conversation.assigned_user_id
    WHERE conversation.assigned_user_id IS NOT NULL
      AND NOT assignee.is_root
      AND NOT EXISTS (
        SELECT 1
        FROM workspace_members member
        WHERE member.workspace_id=conversation.tenant_id
          AND member.user_id=conversation.assigned_user_id
      )
  ) THEN
    RAISE EXCEPTION 'existing conversation assignee belongs to another tenant';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM scheduling_leads lead
    WHERE lead.assigned_member_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM workspace_members member
        WHERE member.id=lead.assigned_member_id
          AND member.workspace_id=lead.tenant_id
      )
  ) THEN
    RAISE EXCEPTION 'existing lead assignee belongs to another tenant';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname='workspace_members_id_workspace_unique'
  ) THEN
    ALTER TABLE workspace_members
      ADD CONSTRAINT workspace_members_id_workspace_unique UNIQUE(id,workspace_id);
  END IF;
END $$;

ALTER TABLE scheduling_leads
  DROP CONSTRAINT IF EXISTS scheduling_leads_assigned_member_id_fkey;
ALTER TABLE scheduling_leads
  ADD CONSTRAINT scheduling_leads_assignee_tenant_fkey
  FOREIGN KEY(assigned_member_id,tenant_id)
  REFERENCES workspace_members(id,workspace_id)
  ON DELETE SET NULL (assigned_member_id);

CREATE OR REPLACE FUNCTION validate_conversation_assignee_tenant()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.assigned_user_id IS NULL THEN
    RETURN NEW;
  END IF;

  PERFORM 1
  FROM users
  WHERE id=NEW.assigned_user_id AND is_root
  FOR KEY SHARE;
  IF FOUND THEN
    RETURN NEW;
  END IF;

  PERFORM 1
  FROM workspace_members
  WHERE workspace_id=NEW.tenant_id AND user_id=NEW.assigned_user_id
  FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'conversation assignee belongs to another tenant';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER conversations_validate_assignee_tenant
BEFORE INSERT OR UPDATE OF tenant_id,assigned_user_id ON conversations
FOR EACH ROW EXECUTE FUNCTION validate_conversation_assignee_tenant();

CREATE OR REPLACE FUNCTION clear_removed_member_conversation_assignments()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM users WHERE id=OLD.user_id AND is_root
  ) THEN
    UPDATE conversations
    SET assigned_user_id=NULL,claimed_at=NULL
    WHERE tenant_id=OLD.workspace_id AND assigned_user_id=OLD.user_id;
  END IF;
  RETURN OLD;
END $$;

CREATE TRIGGER workspace_members_clear_conversation_assignments
BEFORE DELETE ON workspace_members
FOR EACH ROW EXECUTE FUNCTION clear_removed_member_conversation_assignments();
