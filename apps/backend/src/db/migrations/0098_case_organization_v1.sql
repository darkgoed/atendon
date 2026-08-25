ALTER TABLE conversations ADD COLUMN lead_id UUID;

DO $$
DECLARE
  invalid_links JSONB;
BEGIN
  SELECT jsonb_agg(jsonb_build_object(
    'conversation_id',candidate.id,
    'tenant_id',candidate.tenant_id,
    'candidate_count',candidate.candidate_count
  ) ORDER BY candidate.tenant_id,candidate.id)
  INTO invalid_links
  FROM (
    SELECT conversation.id,conversation.tenant_id,count(lead.id)::int candidate_count
    FROM conversations conversation
    LEFT JOIN scheduling_leads lead
      ON lead.tenant_id=conversation.tenant_id
     AND lead.phone=conversation.contact_phone
    GROUP BY conversation.id,conversation.tenant_id
    HAVING count(lead.id)<>1
    ORDER BY conversation.tenant_id,conversation.id
    LIMIT 100
  ) candidate;

  IF invalid_links IS NOT NULL THEN
    RAISE EXCEPTION 'case organization preflight found missing or ambiguous conversation lead links: %', invalid_links;
  END IF;
END $$;

UPDATE conversations conversation
SET lead_id=lead.id
FROM scheduling_leads lead
WHERE lead.tenant_id=conversation.tenant_id
  AND lead.phone=conversation.contact_phone;

ALTER TABLE conversations ALTER COLUMN lead_id SET NOT NULL;
ALTER TABLE conversations
  ADD CONSTRAINT conversations_lead_tenant_fkey
  FOREIGN KEY (lead_id,tenant_id)
  REFERENCES scheduling_leads(id,tenant_id) ON DELETE RESTRICT;
CREATE INDEX idx_conversations_lead_tenant ON conversations(lead_id,tenant_id);

CREATE TABLE lead_tags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  color TEXT NOT NULL CHECK (color ~ '^#[0-9A-Fa-f]{6}$'),
  archived_at TIMESTAMPTZ,
  created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT lead_tags_id_tenant_unique UNIQUE(id,tenant_id)
);
CREATE UNIQUE INDEX uq_lead_tags_active_name
  ON lead_tags(tenant_id,lower(name)) WHERE archived_at IS NULL;
CREATE INDEX idx_lead_tags_tenant_active
  ON lead_tags(tenant_id,archived_at,name);

CREATE TABLE lead_tag_assignments (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  lead_id UUID NOT NULL,
  tag_id UUID NOT NULL,
  created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,lead_id,tag_id),
  CONSTRAINT lead_tag_assignments_lead_fkey
    FOREIGN KEY(lead_id,tenant_id) REFERENCES scheduling_leads(id,tenant_id) ON DELETE CASCADE,
  CONSTRAINT lead_tag_assignments_tag_fkey
    FOREIGN KEY(tag_id,tenant_id) REFERENCES lead_tags(id,tenant_id) ON DELETE CASCADE
);
CREATE INDEX idx_lead_tag_assignments_tag
  ON lead_tag_assignments(tenant_id,tag_id,lead_id);

CREATE TABLE saved_views (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  resource TEXT NOT NULL CHECK (resource IN ('conversations','leads','pipeline')),
  name TEXT NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 100),
  filters JSONB NOT NULL CHECK (jsonb_typeof(filters)='object'),
  shared BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT saved_views_id_tenant_unique UNIQUE(id,tenant_id)
);
CREATE UNIQUE INDEX uq_saved_views_owner_name
  ON saved_views(tenant_id,owner_user_id,resource,lower(name));
CREATE INDEX idx_saved_views_visible
  ON saved_views(tenant_id,resource,shared,owner_user_id);

CREATE TABLE pipeline_stages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  color TEXT NOT NULL CHECK (color ~ '^#[0-9A-Fa-f]{6}$'),
  position INTEGER NOT NULL CHECK (position>=0),
  capacity_target INTEGER CHECK (capacity_target IS NULL OR capacity_target>0),
  technical_status TEXT NOT NULL CHECK (technical_status IN (
    'em_qualificacao','aguardando_proposta','aprovado','recusado',
    'agendado','cancelado','transferido'
  )),
  is_default BOOLEAN NOT NULL DEFAULT false,
  archived_at TIMESTAMPTZ,
  created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pipeline_stages_id_tenant_unique UNIQUE(id,tenant_id)
);
CREATE UNIQUE INDEX uq_pipeline_stages_active_name
  ON pipeline_stages(tenant_id,lower(name)) WHERE archived_at IS NULL;
CREATE UNIQUE INDEX uq_pipeline_stages_default_status
  ON pipeline_stages(tenant_id,technical_status) WHERE is_default AND archived_at IS NULL;
CREATE INDEX idx_pipeline_stages_order
  ON pipeline_stages(tenant_id,archived_at,position,id);

CREATE TABLE pipeline_transitions (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  from_stage_id UUID NOT NULL,
  to_stage_id UUID NOT NULL,
  created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,from_stage_id,to_stage_id),
  CONSTRAINT pipeline_transitions_distinct CHECK (from_stage_id<>to_stage_id),
  CONSTRAINT pipeline_transitions_from_fkey
    FOREIGN KEY(from_stage_id,tenant_id) REFERENCES pipeline_stages(id,tenant_id) ON DELETE CASCADE,
  CONSTRAINT pipeline_transitions_to_fkey
    FOREIGN KEY(to_stage_id,tenant_id) REFERENCES pipeline_stages(id,tenant_id) ON DELETE CASCADE
);
CREATE INDEX idx_pipeline_transitions_to
  ON pipeline_transitions(tenant_id,to_stage_id,from_stage_id);

INSERT INTO pipeline_stages(
  tenant_id,name,color,position,capacity_target,technical_status,is_default
)
SELECT tenant.id,seed.name,seed.color,seed.position,NULL,seed.technical_status,true
FROM tenants tenant
CROSS JOIN (VALUES
  ('Em qualificação','#3B82F6',10,'em_qualificacao'),
  ('Aguardando proposta','#F59E0B',20,'aguardando_proposta'),
  ('Aprovado','#10B981',30,'aprovado'),
  ('Recusado','#EF4444',40,'recusado'),
  ('Agendado','#8B5CF6',50,'agendado'),
  ('Cancelado','#6B7280',60,'cancelado'),
  ('Transferido','#F97316',70,'transferido')
) AS seed(name,color,position,technical_status);

INSERT INTO pipeline_transitions(tenant_id,from_stage_id,to_stage_id)
SELECT source.tenant_id,source.id,target.id
FROM pipeline_stages source
JOIN pipeline_stages target ON target.tenant_id=source.tenant_id
WHERE source.is_default AND target.is_default
  AND (
    (source.technical_status='em_qualificacao' AND target.technical_status=ANY(ARRAY['aguardando_proposta','aprovado','recusado','cancelado'])) OR
    (source.technical_status='aguardando_proposta' AND target.technical_status=ANY(ARRAY['em_qualificacao','aprovado','recusado','cancelado'])) OR
    (source.technical_status='aprovado' AND target.technical_status=ANY(ARRAY['em_qualificacao','recusado','cancelado'])) OR
    (source.technical_status='recusado' AND target.technical_status=ANY(ARRAY['em_qualificacao','cancelado'])) OR
    (source.technical_status='agendado' AND target.technical_status=ANY(ARRAY['aprovado','cancelado'])) OR
    (source.technical_status='cancelado' AND target.technical_status='em_qualificacao') OR
    (source.technical_status='transferido' AND target.technical_status=ANY(ARRAY['em_qualificacao','aguardando_proposta','aprovado','recusado','cancelado']))
  );

CREATE OR REPLACE FUNCTION seed_case_organization_pipeline_for_tenant()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO pipeline_stages(
    tenant_id,name,color,position,capacity_target,technical_status,is_default
  ) VALUES
    (NEW.id,'Em qualificação','#3B82F6',10,NULL,'em_qualificacao',true),
    (NEW.id,'Aguardando proposta','#F59E0B',20,NULL,'aguardando_proposta',true),
    (NEW.id,'Aprovado','#10B981',30,NULL,'aprovado',true),
    (NEW.id,'Recusado','#EF4444',40,NULL,'recusado',true),
    (NEW.id,'Agendado','#8B5CF6',50,NULL,'agendado',true),
    (NEW.id,'Cancelado','#6B7280',60,NULL,'cancelado',true),
    (NEW.id,'Transferido','#F97316',70,NULL,'transferido',true);

  INSERT INTO pipeline_transitions(tenant_id,from_stage_id,to_stage_id)
  SELECT source.tenant_id,source.id,target.id
  FROM pipeline_stages source
  JOIN pipeline_stages target ON target.tenant_id=source.tenant_id
  WHERE source.tenant_id=NEW.id AND source.is_default AND target.is_default
    AND (
      (source.technical_status='em_qualificacao' AND target.technical_status=ANY(ARRAY['aguardando_proposta','aprovado','recusado','cancelado'])) OR
      (source.technical_status='aguardando_proposta' AND target.technical_status=ANY(ARRAY['em_qualificacao','aprovado','recusado','cancelado'])) OR
      (source.technical_status='aprovado' AND target.technical_status=ANY(ARRAY['em_qualificacao','recusado','cancelado'])) OR
      (source.technical_status='recusado' AND target.technical_status=ANY(ARRAY['em_qualificacao','cancelado'])) OR
      (source.technical_status='agendado' AND target.technical_status=ANY(ARRAY['aprovado','cancelado'])) OR
      (source.technical_status='cancelado' AND target.technical_status='em_qualificacao') OR
      (source.technical_status='transferido' AND target.technical_status=ANY(ARRAY['em_qualificacao','aguardando_proposta','aprovado','recusado','cancelado']))
    );
  RETURN NEW;
END;
$$;
CREATE TRIGGER tenants_seed_case_organization_pipeline
AFTER INSERT ON tenants
FOR EACH ROW EXECUTE FUNCTION seed_case_organization_pipeline_for_tenant();

ALTER TABLE scheduling_leads ADD COLUMN pipeline_stage_id UUID;
UPDATE scheduling_leads lead
SET pipeline_stage_id=stage.id
FROM pipeline_stages stage
WHERE stage.tenant_id=lead.tenant_id
  AND stage.technical_status=lead.status
  AND stage.is_default
  AND stage.archived_at IS NULL;
ALTER TABLE scheduling_leads ALTER COLUMN pipeline_stage_id SET NOT NULL;
ALTER TABLE scheduling_leads
  ADD CONSTRAINT scheduling_leads_pipeline_stage_tenant_fkey
  FOREIGN KEY(pipeline_stage_id,tenant_id)
  REFERENCES pipeline_stages(id,tenant_id) ON DELETE RESTRICT;
CREATE INDEX idx_scheduling_leads_pipeline_stage
  ON scheduling_leads(tenant_id,pipeline_stage_id,updated_at DESC);

CREATE OR REPLACE FUNCTION enforce_scheduling_lead_pipeline_stage()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.pipeline_stage_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM pipeline_stages stage
    WHERE stage.id=NEW.pipeline_stage_id
      AND stage.tenant_id=NEW.tenant_id
      AND stage.technical_status=NEW.status
      AND stage.archived_at IS NULL
  ) THEN
    SELECT stage.id INTO NEW.pipeline_stage_id
    FROM pipeline_stages stage
    WHERE stage.tenant_id=NEW.tenant_id
      AND stage.technical_status=NEW.status
      AND stage.is_default
      AND stage.archived_at IS NULL;
  END IF;
  IF NEW.pipeline_stage_id IS NULL THEN
    RAISE EXCEPTION 'no default pipeline stage for tenant % and status %',NEW.tenant_id,NEW.status;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER scheduling_leads_enforce_pipeline_stage
BEFORE INSERT OR UPDATE OF status,pipeline_stage_id ON scheduling_leads
FOR EACH ROW EXECUTE FUNCTION enforce_scheduling_lead_pipeline_stage();

CREATE OR REPLACE FUNCTION link_conversation_to_lead()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.lead_id IS NULL OR TG_OP='UPDATE' AND (
    NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR
    NEW.contact_phone IS DISTINCT FROM OLD.contact_phone
  ) THEN
    SELECT lead.id INTO NEW.lead_id
    FROM scheduling_leads lead
    WHERE lead.tenant_id=NEW.tenant_id AND lead.phone=NEW.contact_phone;

    IF NEW.lead_id IS NULL THEN
      INSERT INTO scheduling_leads(tenant_id,phone,name,source,facebook_attribution)
      VALUES(
        NEW.tenant_id,
        NEW.contact_phone,
        NEW.contact_name,
        CASE WHEN NEW.facebook_attribution <> '{}'::jsonb THEN 'facebook' ELSE 'whatsapp' END,
        NEW.facebook_attribution
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
CREATE TRIGGER conversations_link_lead
BEFORE INSERT OR UPDATE OF tenant_id,contact_phone,lead_id ON conversations
FOR EACH ROW EXECUTE FUNCTION link_conversation_to_lead();

CREATE TABLE bulk_operations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  actor_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK (action IN ('assign','tags_add','tags_remove','move_stage')),
  idempotency_key TEXT NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),
  request_payload JSONB NOT NULL CHECK (jsonb_typeof(request_payload)='object'),
  response_payload JSONB NOT NULL CHECK (jsonb_typeof(response_payload)='object'),
  undo_payload JSONB CHECK (undo_payload IS NULL OR jsonb_typeof(undo_payload)='object'),
  undo_expires_at TIMESTAMPTZ,
  undone_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT bulk_operations_id_tenant_unique UNIQUE(id,tenant_id),
  CONSTRAINT bulk_operations_idempotency_unique UNIQUE(tenant_id,actor_user_id,idempotency_key)
);
CREATE INDEX idx_bulk_operations_undo
  ON bulk_operations(tenant_id,actor_user_id,undo_expires_at)
  WHERE undone_at IS NULL AND undo_payload IS NOT NULL;

INSERT INTO permissions(key,module,action,description)
VALUES
  ('tags.apply','organization','tags_apply','Aplicar e remover etiquetas de leads'),
  ('tags.manage','organization','tags_manage','Administrar o catálogo de etiquetas'),
  ('pipeline.manage','organization','pipeline_manage','Administrar etapas e transições do Pipeline'),
  ('saved_views.publish','organization','saved_views_publish','Publicar visões compartilhadas')
ON CONFLICT(key) DO UPDATE SET
  module=EXCLUDED.module,action=EXCLUDED.action,description=EXCLUDED.description;

INSERT INTO workspace_role_permissions(role_id,permission_key)
SELECT role.id,permission.key
FROM workspace_roles role
JOIN permissions permission ON permission.key='tags.apply'
WHERE role.name IN ('OWNER','ADMIN','SUPERVISOR','OPERADOR')
ON CONFLICT DO NOTHING;

INSERT INTO workspace_role_permissions(role_id,permission_key)
SELECT role.id,permission.key
FROM workspace_roles role
JOIN permissions permission ON permission.key=ANY(ARRAY['tags.manage','pipeline.manage','saved_views.publish']::text[])
WHERE role.name IN ('OWNER','ADMIN','SUPERVISOR')
ON CONFLICT DO NOTHING;

ALTER TABLE feature_flag_definitions
  DROP CONSTRAINT feature_flag_definitions_flag_key_check;
ALTER TABLE feature_flag_definitions
  ADD CONSTRAINT feature_flag_definitions_flag_key_check CHECK (flag_key IN (
    'conversations_delta_v2','alerts_delivery_v2','evaluation_event_enqueue_v2',
    'scheduling_meet_outbox_v2','ai_deterministic_confirmations_v2',
    'evaluator_payload_redaction_v2','state_tool_gating_v2','compact_prompt_v2',
    'case_organization_v1'
  ));
INSERT INTO feature_flag_definitions(flag_key,description,global_enabled)
VALUES('case_organization_v1','Organização de casos, etiquetas, visões e Pipeline configurável',true)
ON CONFLICT(flag_key) DO UPDATE SET
  description=EXCLUDED.description,
  global_enabled=true,
  updated_at=now();
