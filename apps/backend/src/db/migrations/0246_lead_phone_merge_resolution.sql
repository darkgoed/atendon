-- Resolução canônica telefone → lead após merge (auditoria w2 C1).
-- O source de um merge mantém o próprio telefone (UNIQUE(tenant_id,phone)),
-- fica soft-deleted e aponta merged_into_id para o principal. Toda busca de
-- lead por telefone passa a seguir essa cadeia até o lead vivo do merge, em
-- vez de devolver o source mesclado. Lead só na lixeira (sem merge) continua
-- sendo o dono do telefone, como antes.
-- Aditiva e idempotente (CREATE OR REPLACE). Sem alteração de dados.
-- ROLLBACK (manual): reaplicar link_conversation_to_lead de 0184 e
-- DROP FUNCTION IF EXISTS resolve_lead_id_by_phone(uuid,text);

CREATE OR REPLACE FUNCTION resolve_lead_id_by_phone(p_tenant_id uuid, p_phone text)
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  WITH RECURSIVE chain AS (
    SELECT lead.id,lead.merged_into_id,0 AS depth
    FROM scheduling_leads lead
    WHERE lead.tenant_id=p_tenant_id
      AND lead.phone=regexp_replace(p_phone,'\D','','g')
    UNION ALL
    SELECT target.id,target.merged_into_id,chain.depth+1
    FROM chain
    JOIN scheduling_leads target
      ON target.tenant_id=p_tenant_id AND target.id=chain.merged_into_id
    WHERE chain.depth<32
  )
  SELECT id FROM chain WHERE merged_into_id IS NULL LIMIT 1
$$;

CREATE OR REPLACE FUNCTION link_conversation_to_lead()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.instagram_contact_id IS NOT NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.lead_id IS NULL OR TG_OP='UPDATE' AND (
    NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR
    NEW.contact_phone IS DISTINCT FROM OLD.contact_phone
  ) THEN
    NEW.lead_id := resolve_lead_id_by_phone(NEW.tenant_id, NEW.contact_phone);

    IF NEW.lead_id IS NULL THEN
      INSERT INTO scheduling_leads(tenant_id,phone,name,source,facebook_attribution,origin_session_id)
      VALUES(
        NEW.tenant_id,
        NEW.contact_phone,
        NEW.contact_name,
        CASE WHEN NEW.facebook_attribution <> '{}'::jsonb THEN 'facebook' ELSE 'whatsapp' END,
        NEW.facebook_attribution,
        NEW.session_id
      )
      ON CONFLICT(tenant_id,phone) DO UPDATE SET
        name=COALESCE(scheduling_leads.name,EXCLUDED.name),
        facebook_attribution=CASE
          WHEN EXCLUDED.facebook_attribution <> '{}'::jsonb THEN EXCLUDED.facebook_attribution
          ELSE scheduling_leads.facebook_attribution
        END,
        updated_at=now()
      RETURNING id INTO NEW.lead_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
