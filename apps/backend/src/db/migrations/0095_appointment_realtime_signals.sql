CREATE OR REPLACE FUNCTION notify_realtime_appointment_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  previous_user_id uuid;
  assigned_user_id uuid;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.assigned_member_id IS NOT NULL THEN
    SELECT user_id INTO previous_user_id
    FROM workspace_members
    WHERE workspace_id=OLD.tenant_id AND id=OLD.assigned_member_id;
  END IF;

  IF NEW.assigned_member_id IS NOT NULL THEN
    SELECT user_id INTO assigned_user_id
    FROM workspace_members
    WHERE workspace_id=NEW.tenant_id AND id=NEW.assigned_member_id;
  END IF;

  PERFORM pg_notify(
    'atendon_realtime_changes',
    json_build_object(
      'v',1,
      'type','appointment.changed',
      'tenantId',NEW.tenant_id,
      'appointmentId',NEW.id,
      'leadId',NEW.lead_id,
      'entityId',gen_random_uuid(),
      'previousUserId',previous_user_id,
      'assignedUserId',assigned_user_id
    )::text
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS scheduling_appointments_notify_realtime_change ON scheduling_appointments;
CREATE TRIGGER scheduling_appointments_notify_realtime_change
AFTER INSERT OR UPDATE ON scheduling_appointments
FOR EACH ROW
EXECUTE FUNCTION notify_realtime_appointment_change();
