CREATE OR REPLACE FUNCTION normalize_unassigned_handoff()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.assigned_user_id IS NOT NULL
    AND NEW.assigned_user_id IS NULL
    AND NOT NEW.ai_active
    AND NEW.handoff_reason='manually_paused'
  THEN
    NEW.handoff_reason='ai_decided';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER conversations_normalize_unassigned_handoff
BEFORE UPDATE OF assigned_user_id ON conversations
FOR EACH ROW EXECUTE FUNCTION normalize_unassigned_handoff();

CREATE OR REPLACE FUNCTION clear_inactive_member_assignments()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status<>'active' THEN
    UPDATE conversations
    SET assigned_user_id=NULL,claimed_at=NULL
    WHERE tenant_id=NEW.workspace_id AND assigned_user_id=NEW.user_id;

    UPDATE scheduling_leads
    SET assigned_member_id=NULL,updated_at=now()
    WHERE tenant_id=NEW.workspace_id AND assigned_member_id=NEW.id;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER workspace_members_clear_inactive_assignments
AFTER UPDATE OF status ON workspace_members
FOR EACH ROW
WHEN (OLD.status IS DISTINCT FROM NEW.status)
EXECUTE FUNCTION clear_inactive_member_assignments();
