WITH inserted_leads AS (
  INSERT INTO scheduling_leads(
    tenant_id,phone,name,source,facebook_attribution,created_at,updated_at
  )
  SELECT
    conversation.tenant_id,
    conversation.contact_phone,
    conversation.contact_name,
    CASE
      WHEN conversation.facebook_attribution <> '{}'::jsonb THEN 'facebook'
      ELSE 'whatsapp'
    END,
    conversation.facebook_attribution,
    conversation.created_at,
    conversation.last_message_at
  FROM conversations conversation
  WHERE NOT EXISTS (
    SELECT 1
    FROM scheduling_leads lead
    WHERE lead.tenant_id=conversation.tenant_id
      AND regexp_replace(lead.phone,'\D','','g')=
          regexp_replace(conversation.contact_phone,'\D','','g')
  )
  ON CONFLICT (tenant_id,phone) DO NOTHING
  RETURNING id,tenant_id,status
)
INSERT INTO scheduling_lead_events(
  lead_id,tenant_id,event_type,new_status,details
)
SELECT
  id,tenant_id,'lead_criado',status,
  jsonb_build_object('origem_automatica','conversa_existente')
FROM inserted_leads;
