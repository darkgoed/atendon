DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM scheduling_notification_settings settings
    JOIN whatsapp_sessions session ON session.id = settings.session_id
    WHERE session.tenant_id <> settings.tenant_id
  ) THEN
    RAISE EXCEPTION
      'Cannot enforce scheduling notification tenant integrity: settings reference a session from another tenant';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM scheduling_appointment_notifications notification
    JOIN scheduling_appointments appointment ON appointment.id = notification.appointment_id
    WHERE appointment.tenant_id <> notification.tenant_id
  ) THEN
    RAISE EXCEPTION
      'Cannot enforce scheduling notification tenant integrity: notification references an appointment from another tenant';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM scheduling_appointment_notifications notification
    JOIN whatsapp_sessions session ON session.id = notification.session_id
    WHERE session.tenant_id <> notification.tenant_id
  ) THEN
    RAISE EXCEPTION
      'Cannot enforce scheduling notification tenant integrity: notification references a session from another tenant';
  END IF;
END $$;

ALTER TABLE scheduling_notification_settings
  DROP CONSTRAINT IF EXISTS scheduling_notification_settings_session_id_fkey;
ALTER TABLE scheduling_notification_settings
  ADD CONSTRAINT scheduling_notification_settings_session_tenant_fkey
  FOREIGN KEY (session_id, tenant_id)
  REFERENCES whatsapp_sessions(id, tenant_id)
  ON DELETE SET NULL (session_id);

ALTER TABLE scheduling_appointment_notifications
  DROP CONSTRAINT IF EXISTS scheduling_appointment_notifications_appointment_id_fkey;
ALTER TABLE scheduling_appointment_notifications
  DROP CONSTRAINT IF EXISTS scheduling_appointment_notifications_session_id_fkey;
ALTER TABLE scheduling_appointment_notifications
  ADD CONSTRAINT scheduling_appointment_notifications_appointment_tenant_fkey
  FOREIGN KEY (appointment_id, tenant_id)
  REFERENCES scheduling_appointments(id, tenant_id)
  ON DELETE CASCADE;
ALTER TABLE scheduling_appointment_notifications
  ADD CONSTRAINT scheduling_appointment_notifications_session_tenant_fkey
  FOREIGN KEY (session_id, tenant_id)
  REFERENCES whatsapp_sessions(id, tenant_id);

CREATE INDEX IF NOT EXISTS idx_scheduling_notification_settings_session_tenant
  ON scheduling_notification_settings(session_id, tenant_id)
  WHERE session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_scheduling_appointment_notifications_appointment_tenant
  ON scheduling_appointment_notifications(appointment_id, tenant_id);
CREATE INDEX IF NOT EXISTS idx_scheduling_appointment_notifications_session_tenant
  ON scheduling_appointment_notifications(session_id, tenant_id);
