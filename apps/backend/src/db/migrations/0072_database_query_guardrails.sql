-- This migration deliberately never resolves conflicting appointments itself.
-- Audit the complete conflicting set before retrying:
--
-- SELECT tenant_id,lead_id,
--        jsonb_agg(jsonb_build_object(
--          'id',id,'status',status,'start_at',start_at,'end_at',end_at,'created_at',created_at
--        ) ORDER BY created_at,id) AS active_appointments
-- FROM scheduling_appointments
-- WHERE status IN ('confirmado','reagendado')
-- GROUP BY tenant_id,lead_id
-- HAVING count(*) > 1
-- ORDER BY tenant_id,lead_id;
--
-- Resolve each conflict through an audited business operation. Do not delete or
-- auto-cancel rows in the migration, because it cannot infer the valid booking.
DO $$
DECLARE
  duplicate_summary TEXT;
BEGIN
  SELECT string_agg(
    format('tenant=%s lead=%s active_appointments=%s', tenant_id, lead_id, active_appointments),
    '; ' ORDER BY tenant_id, lead_id
  )
  INTO duplicate_summary
  FROM (
    SELECT tenant_id,lead_id,count(*) AS active_appointments
    FROM scheduling_appointments
    WHERE status IN ('confirmado','reagendado')
    GROUP BY tenant_id,lead_id
    HAVING count(*) > 1
    ORDER BY tenant_id,lead_id
    LIMIT 20
  ) duplicates;

  IF duplicate_summary IS NOT NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'Cannot enforce one active appointment per lead: ' || duplicate_summary,
      HINT = 'Resolve the reported active appointment duplicates, audit the resolution, and retry migration 0072.';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_appointments_one_active_per_lead
  ON scheduling_appointments(tenant_id,lead_id)
  WHERE status IN ('confirmado','reagendado');

CREATE INDEX IF NOT EXISTS idx_appointments_active_availability
  ON scheduling_appointments(tenant_id,unit_id,start_at)
  INCLUDE(end_at)
  WHERE status IN ('confirmado','reagendado');

CREATE INDEX IF NOT EXISTS idx_messages_conversation_recent
  ON messages(conversation_id,created_at DESC,id DESC);

CREATE INDEX IF NOT EXISTS idx_alert_receipts_user_alert
  ON system_alert_receipts(tenant_id,user_id,alert_id)
  INCLUDE(read_at,notified_at,created_at);
