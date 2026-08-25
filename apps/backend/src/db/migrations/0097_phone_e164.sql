CREATE OR REPLACE FUNCTION migration_canonical_phone_e164(value text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
STRICT
AS $$
DECLARE
  digits text := regexp_replace(btrim(value),'\D','','g');
  international boolean := btrim(value) LIKE '+%';
  national text;
BEGIN
  IF btrim(value) ~ '[^0-9[:space:]()+.\-/]'
    OR (position('+' in btrim(value)) > 0 AND btrim(value) !~ '^\+[^+]+$')
    OR length(digits) < 8 OR length(digits) > 15 OR digits !~ '^[0-9]+$' THEN
    RETURN NULL;
  END IF;
  IF international THEN
    IF digits !~ '^[1-9][0-9]*$' THEN RETURN NULL; END IF;
    IF digits LIKE '55%' THEN
      national := substring(digits FROM 3);
      IF national !~ '^[1-9][0-9]{9,10}$' OR substring(national FROM 1 FOR 2) <> ALL(ARRAY[
        '11','12','13','14','15','16','17','18','19','21','22','24','27','28','31','32','33','34','35','37','38',
        '41','42','43','44','45','46','47','48','49','51','53','54','55','61','62','63','64','65','66','67','68','69',
        '71','73','74','75','77','79','81','82','83','84','85','86','87','88','89','91','92','93','94','95','96','97','98','99'
      ]) THEN RETURN NULL; END IF;
    END IF;
    RETURN digits;
  END IF;
  IF digits LIKE '55%' AND substring(digits FROM 3) ~ '^[1-9][0-9]{9,10}$' THEN national := substring(digits FROM 3);
  ELSIF digits ~ '^[1-9][0-9]{9,10}$' THEN national := digits;
  ELSIF digits ~ '^0[1-9][0-9]{9,10}$' THEN national := substring(digits FROM 2);
  ELSIF digits ~ '^0[0-9]{2}[1-9][0-9]{9,10}$' THEN national := substring(digits FROM 4);
  ELSE RETURN NULL;
  END IF;
  IF substring(national FROM 1 FOR 2) <> ALL(ARRAY[
    '11','12','13','14','15','16','17','18','19','21','22','24','27','28','31','32','33','34','35','37','38',
    '41','42','43','44','45','46','47','48','49','51','53','54','55','61','62','63','64','65','66','67','68','69',
    '71','73','74','75','77','79','81','82','83','84','85','86','87','88','89','91','92','93','94','95','96','97','98','99'
  ]) THEN RETURN NULL; END IF;
  RETURN '55' || national;
END;
$$;

DO $$
DECLARE report jsonb;
BEGIN
  WITH values_to_check AS (
    SELECT tenant_id,id,'scheduling_leads' source,migration_canonical_phone_e164(phone) canonical FROM scheduling_leads
    UNION ALL SELECT tenant_id,id,'conversations',migration_canonical_phone_e164(contact_phone) FROM conversations
    UNION ALL SELECT tenant_id,id,'qualification_message_outbox',migration_canonical_phone_e164(contact_phone)
      FROM qualification_message_outbox
    UNION ALL SELECT tenant_id,id,'scheduling_meeting_contact_delivery_outbox',migration_canonical_phone_e164(contact_phone)
      FROM scheduling_meeting_contact_delivery_outbox
  ), invalid AS (
    SELECT tenant_id,source,array_agg(id ORDER BY id) ids
    FROM values_to_check WHERE canonical IS NULL GROUP BY tenant_id,source
  )
  SELECT jsonb_agg(jsonb_build_object('tenant_id',tenant_id,'source',source,'ids',ids)) INTO report FROM invalid;
  IF report IS NOT NULL THEN
    RAISE EXCEPTION 'E164 preflight found invalid values (phones omitted): %', report;
  END IF;

  WITH canonical AS (
    SELECT tenant_id,id,'scheduling_leads' source,migration_canonical_phone_e164(phone) phone FROM scheduling_leads
    UNION ALL SELECT tenant_id,id,'conversations',migration_canonical_phone_e164(contact_phone) FROM conversations
  ), collisions AS (
    SELECT tenant_id,source,phone,array_agg(id ORDER BY id) ids
    FROM canonical GROUP BY tenant_id,source,phone HAVING count(*) > 1
  )
  SELECT jsonb_agg(jsonb_build_object('tenant_id',tenant_id,'source',source,'ids',ids)) INTO report FROM collisions;
  IF report IS NOT NULL THEN
    RAISE EXCEPTION 'E164 preflight found canonical collisions (phones omitted): %', report;
  END IF;
END $$;

UPDATE scheduling_leads SET phone=migration_canonical_phone_e164(phone);
UPDATE conversations
SET contact_phone=migration_canonical_phone_e164(contact_phone),
    contact_jid=CASE WHEN contact_jid LIKE '%@s.whatsapp.net'
      THEN migration_canonical_phone_e164(contact_phone) || '@s.whatsapp.net' ELSE contact_jid END;
UPDATE qualification_message_outbox
SET contact_phone=migration_canonical_phone_e164(contact_phone),
    contact_jid=CASE WHEN contact_jid LIKE '%@s.whatsapp.net'
      THEN migration_canonical_phone_e164(contact_phone) || '@s.whatsapp.net' ELSE contact_jid END;
UPDATE scheduling_meeting_contact_delivery_outbox
SET contact_phone=migration_canonical_phone_e164(contact_phone),
    contact_jid=CASE WHEN contact_jid LIKE '%@s.whatsapp.net'
      THEN migration_canonical_phone_e164(contact_phone) || '@s.whatsapp.net' ELSE contact_jid END,
    updated_at=now();

ALTER TABLE scheduling_leads ADD CONSTRAINT scheduling_leads_phone_e164_check CHECK (phone ~ '^[1-9][0-9]{7,14}$');
ALTER TABLE conversations ADD CONSTRAINT conversations_phone_e164_check CHECK (contact_phone ~ '^[1-9][0-9]{7,14}$');
ALTER TABLE qualification_message_outbox ADD CONSTRAINT qualification_outbox_phone_e164_check CHECK (contact_phone ~ '^[1-9][0-9]{7,14}$');
ALTER TABLE scheduling_meeting_contact_delivery_outbox DROP CONSTRAINT IF EXISTS scheduling_meeting_contact_delivery_outbox_contact_phone_check;
ALTER TABLE scheduling_meeting_contact_delivery_outbox ADD CONSTRAINT scheduling_meeting_contact_delivery_phone_e164_check CHECK (contact_phone ~ '^[1-9][0-9]{7,14}$');

CREATE UNIQUE INDEX uq_scheduling_leads_phone_e164 ON scheduling_leads(tenant_id,phone);
CREATE UNIQUE INDEX uq_conversations_phone_e164 ON conversations(tenant_id,contact_phone);

DROP FUNCTION migration_canonical_phone_e164(text);
