DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM scheduling_leads
    WHERE regexp_replace(phone, '\D', '', 'g') <> ''
    GROUP BY tenant_id, regexp_replace(phone, '\D', '', 'g')
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION
      'Cannot enforce normalized lead phone integrity: duplicate normalized phones exist';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_scheduling_leads_tenant_normalized_phone
  ON scheduling_leads(tenant_id, regexp_replace(phone, '\D', '', 'g'))
  WHERE regexp_replace(phone, '\D', '', 'g') <> '';

ALTER TABLE scheduling_appointments
  ADD COLUMN IF NOT EXISTS creation_request_hash TEXT;
