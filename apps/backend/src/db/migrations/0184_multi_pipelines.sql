-- 0184: Múltiplos pipelines por empresa.
--   Empresa → canais (whatsapp_sessions.pipeline_id) → pipelines → etapas → contatos.
--   * Cada tenant existente ganha 1 pipeline padrão ("Pipeline principal") que
--     recebe TODAS as etapas atuais (ids preservados, leads intocados) e herda o
--     modo de movimentação do tenant (tenants.pipeline_enforce_transitions).
--   * Tenant NOVO nasce limpo: 1 pipeline "Pipeline padrão" com 1 etapa
--     "Primeiro contato" — sem etapas comerciais pré-configuradas nem transições.
--   * Etapa ↔ status técnico deixa de ser um acoplamento rígido: a etapa guarda
--     um "comportamento" (technical_status) usado ao MOVER manualmente; mudanças
--     de status feitas pelo sistema só trocam a etapa se o pipeline do lead tiver
--     uma etapa com aquele comportamento. Um lead nunca muda de pipeline sozinho.
--   * Novo contato entra na PRIMEIRA etapa do pipeline vinculado ao canal de
--     origem (scheduling_leads.origin_session_id / instagram_session_id) ou do
--     pipeline padrão.
--   * Ordem das etapas continua em pipeline_stages.position (interna; a UI
--     reordena por arrastar e o backend normaliza).
--
-- ROLLBACK (manual; perde pipelines extras):
--   DROP TRIGGER scheduling_leads_enforce_pipeline_stage ON scheduling_leads; recriar a versão de 0112;
--   ALTER TABLE scheduling_leads DROP COLUMN origin_session_id;
--   ALTER TABLE whatsapp_sessions DROP COLUMN pipeline_id;
--   ALTER TABLE pipeline_stages DROP COLUMN automation, DROP COLUMN pipeline_id; (recriar índices de 0098)
--   DROP TABLE pipelines; DROP FUNCTION tenant_default_pipeline, pipeline_entry_stage, pipeline_stage_for_status;
--   recriar seed_case_organization_pipeline_for_tenant de 0112.

CREATE TABLE IF NOT EXISTS pipelines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  color TEXT NOT NULL DEFAULT '#22D3EE' CHECK (color ~ '^#[0-9A-Fa-f]{6}$'),
  position INTEGER NOT NULL DEFAULT 0 CHECK (position>=0),
  is_default BOOLEAN NOT NULL DEFAULT false,
  enforce_transitions BOOLEAN NOT NULL DEFAULT false,
  archived_at TIMESTAMPTZ,
  created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pipelines_id_tenant_unique UNIQUE(id,tenant_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_pipelines_active_name
  ON pipelines(tenant_id,lower(name)) WHERE archived_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_pipelines_default
  ON pipelines(tenant_id) WHERE is_default AND archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_pipelines_order
  ON pipelines(tenant_id,archived_at,position,id);

-- 1 pipeline padrão por tenant existente, herdando o modo de movimentação.
INSERT INTO pipelines(tenant_id,name,position,is_default,enforce_transitions)
SELECT tenant.id,'Pipeline principal',0,true,COALESCE(tenant.pipeline_enforce_transitions,false)
FROM tenants tenant
WHERE NOT EXISTS (SELECT 1 FROM pipelines existing WHERE existing.tenant_id=tenant.id);

ALTER TABLE pipeline_stages ADD COLUMN IF NOT EXISTS pipeline_id UUID;
ALTER TABLE pipeline_stages ADD COLUMN IF NOT EXISTS automation JSONB NOT NULL DEFAULT '{}'::jsonb;
UPDATE pipeline_stages stage
SET pipeline_id=pipeline.id
FROM pipelines pipeline
WHERE stage.pipeline_id IS NULL AND pipeline.tenant_id=stage.tenant_id AND pipeline.is_default AND pipeline.archived_at IS NULL;
ALTER TABLE pipeline_stages ALTER COLUMN pipeline_id SET NOT NULL;
ALTER TABLE pipeline_stages DROP CONSTRAINT IF EXISTS pipeline_stages_pipeline_tenant_fkey;
ALTER TABLE pipeline_stages
  ADD CONSTRAINT pipeline_stages_pipeline_tenant_fkey
  FOREIGN KEY(pipeline_id,tenant_id) REFERENCES pipelines(id,tenant_id) ON DELETE CASCADE;
ALTER TABLE pipeline_stages DROP CONSTRAINT IF EXISTS pipeline_stages_automation_object;
ALTER TABLE pipeline_stages ADD CONSTRAINT pipeline_stages_automation_object CHECK (jsonb_typeof(automation)='object');

-- Unicidades passam a ser POR PIPELINE (duas empresas/pipelines podem ter "Qualificação").
DROP INDEX IF EXISTS uq_pipeline_stages_active_name;
CREATE UNIQUE INDEX uq_pipeline_stages_active_name
  ON pipeline_stages(tenant_id,pipeline_id,lower(name)) WHERE archived_at IS NULL;
DROP INDEX IF EXISTS uq_pipeline_stages_default_status;
CREATE UNIQUE INDEX uq_pipeline_stages_default_status
  ON pipeline_stages(tenant_id,pipeline_id,technical_status) WHERE is_default AND archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_pipeline_stages_pipeline_order
  ON pipeline_stages(tenant_id,pipeline_id,archived_at,position,id);

-- Canal (WhatsApp/Instagram) → pipeline de entrada. NULL = pipeline padrão.
ALTER TABLE whatsapp_sessions ADD COLUMN IF NOT EXISTS pipeline_id UUID;
ALTER TABLE whatsapp_sessions DROP CONSTRAINT IF EXISTS whatsapp_sessions_pipeline_tenant_fkey;
ALTER TABLE whatsapp_sessions
  ADD CONSTRAINT whatsapp_sessions_pipeline_tenant_fkey
  FOREIGN KEY(pipeline_id,tenant_id) REFERENCES pipelines(id,tenant_id) ON DELETE SET NULL (pipeline_id);
CREATE INDEX IF NOT EXISTS idx_whatsapp_sessions_pipeline
  ON whatsapp_sessions(tenant_id,pipeline_id) WHERE pipeline_id IS NOT NULL;

-- Canal de origem do contato (define o pipeline de entrada).
ALTER TABLE scheduling_leads ADD COLUMN IF NOT EXISTS origin_session_id UUID;
ALTER TABLE scheduling_leads DROP CONSTRAINT IF EXISTS scheduling_leads_origin_session_tenant_fkey;
ALTER TABLE scheduling_leads
  ADD CONSTRAINT scheduling_leads_origin_session_tenant_fkey
  FOREIGN KEY(origin_session_id,tenant_id) REFERENCES whatsapp_sessions(id,tenant_id) ON DELETE SET NULL (origin_session_id);
UPDATE scheduling_leads lead
SET origin_session_id=first_conversation.session_id
FROM (
  SELECT DISTINCT ON (conversation.tenant_id,conversation.lead_id)
         conversation.tenant_id,conversation.lead_id,conversation.session_id
  FROM conversations conversation
  WHERE conversation.lead_id IS NOT NULL
  ORDER BY conversation.tenant_id,conversation.lead_id,conversation.created_at,conversation.id
) first_conversation
WHERE lead.origin_session_id IS NULL
  AND first_conversation.tenant_id=lead.tenant_id
  AND first_conversation.lead_id=lead.id;

CREATE OR REPLACE FUNCTION tenant_default_pipeline(p_tenant UUID)
RETURNS UUID LANGUAGE sql STABLE AS $$
  SELECT pipeline.id FROM pipelines pipeline
  WHERE pipeline.tenant_id=p_tenant AND pipeline.archived_at IS NULL
  ORDER BY pipeline.is_default DESC,pipeline.position,pipeline.created_at,pipeline.id
  LIMIT 1
$$;

-- Compat: INSERT sem pipeline_id (código/presets anteriores) cai no pipeline padrão.
CREATE OR REPLACE FUNCTION default_pipeline_stage_pipeline()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.pipeline_id IS NULL THEN NEW.pipeline_id := tenant_default_pipeline(NEW.tenant_id); END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS pipeline_stages_default_pipeline ON pipeline_stages;
CREATE TRIGGER pipeline_stages_default_pipeline
  BEFORE INSERT ON pipeline_stages
  FOR EACH ROW EXECUTE FUNCTION default_pipeline_stage_pipeline();

CREATE OR REPLACE FUNCTION pipeline_entry_stage(p_tenant UUID, p_pipeline UUID)
RETURNS UUID LANGUAGE sql STABLE AS $$
  SELECT stage.id FROM pipeline_stages stage
  WHERE stage.tenant_id=p_tenant AND stage.pipeline_id=p_pipeline AND stage.archived_at IS NULL
  ORDER BY stage.position,stage.created_at,stage.id
  LIMIT 1
$$;

CREATE OR REPLACE FUNCTION pipeline_stage_for_status(p_tenant UUID, p_pipeline UUID, p_status TEXT)
RETURNS UUID LANGUAGE sql STABLE AS $$
  SELECT stage.id FROM pipeline_stages stage
  WHERE stage.tenant_id=p_tenant AND stage.pipeline_id=p_pipeline
    AND stage.technical_status=p_status AND stage.archived_at IS NULL
  ORDER BY stage.is_default DESC,stage.position,stage.id
  LIMIT 1
$$;

CREATE OR REPLACE FUNCTION enforce_scheduling_lead_pipeline_stage()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_pipeline UUID;
  mapped_stage UUID;
BEGIN
  -- Etapa explícita e ativa do próprio tenant: respeitada.
  IF NEW.pipeline_stage_id IS NOT NULL THEN
    SELECT stage.pipeline_id INTO target_pipeline
    FROM pipeline_stages stage
    WHERE stage.id=NEW.pipeline_stage_id AND stage.tenant_id=NEW.tenant_id AND stage.archived_at IS NULL;
  END IF;
  IF target_pipeline IS NOT NULL THEN
    -- Mudança SOMENTE de status (automação do sistema): acompanha a etapa com o
    -- mesmo comportamento no MESMO pipeline, quando existir; senão fica onde está.
    IF TG_OP='UPDATE' AND NEW.status IS DISTINCT FROM OLD.status
       AND NEW.pipeline_stage_id IS NOT DISTINCT FROM OLD.pipeline_stage_id THEN
      mapped_stage := pipeline_stage_for_status(NEW.tenant_id,target_pipeline,NEW.status);
      IF mapped_stage IS NOT NULL THEN NEW.pipeline_stage_id := mapped_stage; END IF;
    END IF;
    RETURN NEW;
  END IF;

  -- Sem etapa válida: pipeline anterior do lead → pipeline do canal de origem → padrão.
  IF TG_OP='UPDATE' AND OLD.pipeline_stage_id IS NOT NULL THEN
    SELECT stage.pipeline_id INTO target_pipeline
    FROM pipeline_stages stage
    JOIN pipelines pipeline ON pipeline.id=stage.pipeline_id AND pipeline.tenant_id=stage.tenant_id AND pipeline.archived_at IS NULL
    WHERE stage.id=OLD.pipeline_stage_id AND stage.tenant_id=NEW.tenant_id;
  END IF;
  IF target_pipeline IS NULL AND COALESCE(NEW.origin_session_id,NEW.instagram_session_id) IS NOT NULL THEN
    SELECT session.pipeline_id INTO target_pipeline
    FROM whatsapp_sessions session
    JOIN pipelines pipeline ON pipeline.id=session.pipeline_id AND pipeline.tenant_id=session.tenant_id AND pipeline.archived_at IS NULL
    WHERE session.id=COALESCE(NEW.origin_session_id,NEW.instagram_session_id) AND session.tenant_id=NEW.tenant_id;
  END IF;
  IF target_pipeline IS NULL THEN
    target_pipeline := tenant_default_pipeline(NEW.tenant_id);
  END IF;

  -- Contato novo entra na PRIMEIRA etapa; status explícito procura a etapa com o
  -- mesmo comportamento antes de cair na primeira.
  IF TG_OP='INSERT' AND NEW.status='novo' THEN
    NEW.pipeline_stage_id := pipeline_entry_stage(NEW.tenant_id,target_pipeline);
  ELSE
    NEW.pipeline_stage_id := COALESCE(
      pipeline_stage_for_status(NEW.tenant_id,target_pipeline,NEW.status),
      pipeline_entry_stage(NEW.tenant_id,target_pipeline)
    );
  END IF;
  IF NEW.pipeline_stage_id IS NULL THEN
    RAISE EXCEPTION 'no pipeline stage for tenant %',NEW.tenant_id;
  END IF;
  RETURN NEW;
END;
$$;

-- Empresa nova: ambiente cru — 1 pipeline, 1 etapa, zero transições.
CREATE OR REPLACE FUNCTION seed_case_organization_pipeline_for_tenant()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  new_pipeline UUID;
BEGIN
  INSERT INTO pipelines(tenant_id,name,position,is_default,enforce_transitions)
  VALUES(NEW.id,'Pipeline padrão',0,true,COALESCE(NEW.pipeline_enforce_transitions,false))
  RETURNING id INTO new_pipeline;
  INSERT INTO pipeline_stages(
    tenant_id,pipeline_id,name,color,position,capacity_target,technical_status,is_default
  ) VALUES(NEW.id,new_pipeline,'Primeiro contato','#64748B',0,NULL,'novo',true);
  RETURN NEW;
END;
$$;

-- Transição automática perdido→fechado só dentro do MESMO pipeline.
CREATE OR REPLACE FUNCTION ensure_lost_to_closed_pipeline_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO pipeline_transitions(tenant_id,from_stage_id,to_stage_id)
  SELECT source.tenant_id,source.id,target.id
  FROM pipeline_stages source
  JOIN pipeline_stages target ON target.tenant_id=source.tenant_id AND target.pipeline_id=source.pipeline_id
  WHERE source.tenant_id=NEW.tenant_id
    AND source.pipeline_id=NEW.pipeline_id
    AND source.technical_status='perdido'
    AND target.technical_status='fechado'
    AND source.archived_at IS NULL
    AND target.archived_at IS NULL
  ON CONFLICT(tenant_id,from_stage_id,to_stage_id) DO NOTHING;
  RETURN NEW;
END;
$$;

-- Lead criado pela conversa guarda o canal de origem (pipeline de entrada).
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
    SELECT lead.id INTO NEW.lead_id
    FROM scheduling_leads lead
    WHERE lead.tenant_id=NEW.tenant_id AND lead.phone=NEW.contact_phone;

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

COMMENT ON COLUMN tenants.pipeline_enforce_transitions IS
  'LEGADO (0184): o modo de movimentação agora é por pipeline (pipelines.enforce_transitions). Mantido só como espelho do pipeline padrão.';
