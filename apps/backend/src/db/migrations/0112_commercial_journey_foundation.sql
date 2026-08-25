-- Canonical commercial journey, attribution and structured meeting outcomes.
-- Existing pipeline stage ids and lead links are intentionally preserved.

DROP TRIGGER IF EXISTS scheduling_leads_enforce_pipeline_stage ON scheduling_leads;

ALTER TABLE scheduling_leads
  DROP CONSTRAINT IF EXISTS scheduling_leads_status_check;
ALTER TABLE pipeline_stages
  DROP CONSTRAINT IF EXISTS pipeline_stages_technical_status_check;

UPDATE pipeline_stages
SET technical_status=CASE technical_status
  WHEN 'em_qualificacao' THEN 'em_atendimento'
  WHEN 'aguardando_proposta' THEN 'proposta_enviada'
  WHEN 'aprovado' THEN 'qualificado'
  WHEN 'recusado' THEN 'perdido'
  WHEN 'cancelado' THEN 'follow_up'
  WHEN 'transferido' THEN 'aguardando_resposta'
  ELSE technical_status
END;

UPDATE scheduling_leads
SET status=CASE status
  WHEN 'em_qualificacao' THEN 'em_atendimento'
  WHEN 'aguardando_proposta' THEN 'proposta_enviada'
  WHEN 'aprovado' THEN 'qualificado'
  WHEN 'recusado' THEN 'perdido'
  WHEN 'cancelado' THEN 'follow_up'
  WHEN 'transferido' THEN 'aguardando_resposta'
  ELSE status
END;

ALTER TABLE scheduling_leads ALTER COLUMN status SET DEFAULT 'novo';
ALTER TABLE scheduling_leads
  ADD CONSTRAINT scheduling_leads_status_check CHECK (status IN (
    'novo','em_atendimento','aguardando_resposta','qualificado','agendado',
    'em_negociacao','proposta_enviada','follow_up','fechado','perdido'
  ));
ALTER TABLE pipeline_stages
  ADD CONSTRAINT pipeline_stages_technical_status_check CHECK (technical_status IN (
    'novo','em_atendimento','aguardando_resposta','qualificado','agendado',
    'em_negociacao','proposta_enviada','follow_up','fechado','perdido'
  ));

-- Free canonical names before renaming defaults without discarding custom rows.
WITH desired(technical_status,name) AS (VALUES
  ('novo','Novo'),('em_atendimento','Em atendimento'),
  ('aguardando_resposta','Aguardando resposta'),('qualificado','Qualificado'),
  ('agendado','Agendado'),('em_negociacao','Em negociação'),
  ('proposta_enviada','Proposta enviada'),('follow_up','Follow-up'),
  ('fechado','Fechado'),('perdido','Perdido')
)
UPDATE pipeline_stages stage
SET name=left(stage.name,58) || ' (personalizada ' || substr(stage.id::text,1,8) || ')',
    updated_at=now()
FROM desired
WHERE stage.archived_at IS NULL
  AND NOT stage.is_default
  AND lower(stage.name)=lower(desired.name);

WITH desired(technical_status,name,color,position) AS (VALUES
  ('novo','Novo','#64748B',10),
  ('em_atendimento','Em atendimento','#3B82F6',20),
  ('aguardando_resposta','Aguardando resposta','#F59E0B',30),
  ('qualificado','Qualificado','#14B8A6',40),
  ('agendado','Agendado','#8B5CF6',50),
  ('em_negociacao','Em negociação','#6366F1',60),
  ('proposta_enviada','Proposta enviada','#0EA5E9',70),
  ('follow_up','Follow-up','#F97316',80),
  ('fechado','Fechado','#10B981',90),
  ('perdido','Perdido','#EF4444',100)
)
UPDATE pipeline_stages stage
SET name=desired.name,color=desired.color,position=desired.position,updated_at=now()
FROM desired
WHERE stage.technical_status=desired.technical_status AND stage.is_default;

INSERT INTO pipeline_stages(
  tenant_id,name,color,position,capacity_target,technical_status,is_default
)
SELECT tenant.id,desired.name,desired.color,desired.position,NULL,desired.technical_status,true
FROM tenants tenant
CROSS JOIN (VALUES
  ('novo','Novo','#64748B',10),
  ('em_atendimento','Em atendimento','#3B82F6',20),
  ('aguardando_resposta','Aguardando resposta','#F59E0B',30),
  ('qualificado','Qualificado','#14B8A6',40),
  ('agendado','Agendado','#8B5CF6',50),
  ('em_negociacao','Em negociação','#6366F1',60),
  ('proposta_enviada','Proposta enviada','#0EA5E9',70),
  ('follow_up','Follow-up','#F97316',80),
  ('fechado','Fechado','#10B981',90),
  ('perdido','Perdido','#EF4444',100)
) AS desired(technical_status,name,color,position)
WHERE NOT EXISTS (
  SELECT 1 FROM pipeline_stages stage
  WHERE stage.tenant_id=tenant.id
    AND stage.technical_status=desired.technical_status
    AND stage.is_default AND stage.archived_at IS NULL
);

-- Keep configured/custom transitions and add the canonical defaults.
INSERT INTO pipeline_transitions(tenant_id,from_stage_id,to_stage_id)
SELECT source.tenant_id,source.id,target.id
FROM pipeline_stages source
JOIN pipeline_stages target ON target.tenant_id=source.tenant_id
WHERE source.is_default AND source.archived_at IS NULL
  AND target.is_default AND target.archived_at IS NULL
  AND (
    (source.technical_status='novo' AND target.technical_status=ANY(ARRAY['em_atendimento','perdido'])) OR
    (source.technical_status='em_atendimento' AND target.technical_status=ANY(ARRAY['aguardando_resposta','qualificado','proposta_enviada','follow_up','perdido'])) OR
    (source.technical_status='aguardando_resposta' AND target.technical_status=ANY(ARRAY['em_atendimento','qualificado','proposta_enviada','follow_up','perdido'])) OR
    (source.technical_status='qualificado' AND target.technical_status=ANY(ARRAY['em_atendimento','agendado','em_negociacao','proposta_enviada','follow_up','perdido'])) OR
    (source.technical_status='agendado' AND target.technical_status=ANY(ARRAY['qualificado','em_negociacao','proposta_enviada','follow_up','fechado','perdido'])) OR
    (source.technical_status='em_negociacao' AND target.technical_status=ANY(ARRAY['proposta_enviada','follow_up','fechado','perdido'])) OR
    (source.technical_status='proposta_enviada' AND target.technical_status=ANY(ARRAY['em_negociacao','qualificado','follow_up','fechado','perdido'])) OR
    (source.technical_status='follow_up' AND target.technical_status=ANY(ARRAY['em_atendimento','aguardando_resposta','qualificado','agendado','em_negociacao','proposta_enviada','fechado','perdido'])) OR
    (source.technical_status='perdido' AND target.technical_status=ANY(ARRAY['em_atendimento','follow_up']))
  )
ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION seed_case_organization_pipeline_for_tenant()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO pipeline_stages(
    tenant_id,name,color,position,capacity_target,technical_status,is_default
  ) VALUES
    (NEW.id,'Novo','#64748B',10,NULL,'novo',true),
    (NEW.id,'Em atendimento','#3B82F6',20,NULL,'em_atendimento',true),
    (NEW.id,'Aguardando resposta','#F59E0B',30,NULL,'aguardando_resposta',true),
    (NEW.id,'Qualificado','#14B8A6',40,NULL,'qualificado',true),
    (NEW.id,'Agendado','#8B5CF6',50,NULL,'agendado',true),
    (NEW.id,'Em negociação','#6366F1',60,NULL,'em_negociacao',true),
    (NEW.id,'Proposta enviada','#0EA5E9',70,NULL,'proposta_enviada',true),
    (NEW.id,'Follow-up','#F97316',80,NULL,'follow_up',true),
    (NEW.id,'Fechado','#10B981',90,NULL,'fechado',true),
    (NEW.id,'Perdido','#EF4444',100,NULL,'perdido',true);

  INSERT INTO pipeline_transitions(tenant_id,from_stage_id,to_stage_id)
  SELECT source.tenant_id,source.id,target.id
  FROM pipeline_stages source
  JOIN pipeline_stages target ON target.tenant_id=source.tenant_id
  WHERE source.tenant_id=NEW.id AND source.is_default AND target.is_default
    AND (
      (source.technical_status='novo' AND target.technical_status=ANY(ARRAY['em_atendimento','perdido'])) OR
      (source.technical_status='em_atendimento' AND target.technical_status=ANY(ARRAY['aguardando_resposta','qualificado','proposta_enviada','follow_up','perdido'])) OR
      (source.technical_status='aguardando_resposta' AND target.technical_status=ANY(ARRAY['em_atendimento','qualificado','proposta_enviada','follow_up','perdido'])) OR
      (source.technical_status='qualificado' AND target.technical_status=ANY(ARRAY['em_atendimento','agendado','em_negociacao','proposta_enviada','follow_up','perdido'])) OR
      (source.technical_status='agendado' AND target.technical_status=ANY(ARRAY['qualificado','em_negociacao','proposta_enviada','follow_up','fechado','perdido'])) OR
      (source.technical_status='em_negociacao' AND target.technical_status=ANY(ARRAY['proposta_enviada','follow_up','fechado','perdido'])) OR
      (source.technical_status='proposta_enviada' AND target.technical_status=ANY(ARRAY['em_negociacao','qualificado','follow_up','fechado','perdido'])) OR
      (source.technical_status='follow_up' AND target.technical_status=ANY(ARRAY['em_atendimento','aguardando_resposta','qualificado','agendado','em_negociacao','proposta_enviada','fechado','perdido'])) OR
      (source.technical_status='perdido' AND target.technical_status=ANY(ARRAY['em_atendimento','follow_up']))
    );
  RETURN NEW;
END;
$$;

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

ALTER TABLE scheduling_leads
  ADD COLUMN campaign TEXT,
  ADD COLUMN sdr_member_id UUID,
  ADD COLUMN closer_member_id UUID,
  ADD COLUMN recovery_required BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN recovery_member_id UUID,
  ADD COLUMN handoff_at TIMESTAMPTZ,
  ADD COLUMN handoff_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN commercial_outcome TEXT,
  ADD COLUMN sale_value NUMERIC(14,2),
  ADD COLUMN loss_reason TEXT,
  ADD COLUMN commercial_updated_at TIMESTAMPTZ,
  ADD COLUMN commercial_updated_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE scheduling_lead_events
  ADD COLUMN actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE conversations
  DROP CONSTRAINT IF EXISTS conversations_handoff_reason_check;
ALTER TABLE conversations
  ADD CONSTRAINT conversations_handoff_reason_check CHECK (
    handoff_reason IS NULL OR handoff_reason IN (
      'ai_decided','contact_requested','manually_paused','technical_failure','commercial_handoff'
    )
  );

ALTER TABLE scheduling_appointments
  ADD COLUMN result_pending_at TIMESTAMPTZ,
  ADD COLUMN commercial_outcome TEXT,
  ADD COLUMN sale_value NUMERIC(14,2),
  ADD COLUMN loss_reason TEXT,
  ADD COLUMN outcome_next_action TEXT,
  ADD COLUMN outcome_next_action_at TIMESTAMPTZ,
  ADD COLUMN outcome_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN finalized_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN finalized_at TIMESTAMPTZ,
  ADD COLUMN cancellation_disposition TEXT,
  ADD COLUMN created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE scheduling_leads
  ADD CONSTRAINT scheduling_leads_sdr_member_tenant_fkey
    FOREIGN KEY(sdr_member_id,tenant_id) REFERENCES workspace_members(id,workspace_id) ON DELETE SET NULL (sdr_member_id),
  ADD CONSTRAINT scheduling_leads_closer_member_tenant_fkey
    FOREIGN KEY(closer_member_id,tenant_id) REFERENCES workspace_members(id,workspace_id) ON DELETE SET NULL (closer_member_id),
  ADD CONSTRAINT scheduling_leads_recovery_member_tenant_fkey
    FOREIGN KEY(recovery_member_id,tenant_id) REFERENCES workspace_members(id,workspace_id) ON DELETE SET NULL (recovery_member_id),
  ADD CONSTRAINT scheduling_leads_commercial_outcome_check
    CHECK (commercial_outcome IS NULL OR commercial_outcome IN (
      'fechado','proposta_enviada','em_negociacao','follow_up','nao_avancou'
    )),
  ADD CONSTRAINT scheduling_leads_loss_reason_check
    CHECK (loss_reason IS NULL OR loss_reason IN (
      'preco','sem_interesse','sem_momento','nao_qualificado',
      'concorrente','sem_retorno','outro'
    )),
  ADD CONSTRAINT scheduling_leads_sale_value_check
    CHECK (sale_value IS NULL OR sale_value>0),
  ADD CONSTRAINT scheduling_leads_recovery_owner_check
    CHECK (NOT recovery_required OR (
      recovery_member_id IS NOT NULL
      AND nullif(btrim(next_action),'') IS NOT NULL
      AND next_action_at IS NOT NULL
    ));

-- `perdido` can only originate from the former `recusado` state at this point.
-- Preserve the uncertainty explicitly instead of leaving a terminal lead invalid.
UPDATE scheduling_leads
SET commercial_outcome='nao_avancou',loss_reason='outro',
    commercial_updated_at=COALESCE(updated_at,created_at)
WHERE status='perdido' AND commercial_outcome IS NULL;

ALTER TABLE scheduling_leads
  ADD CONSTRAINT scheduling_leads_closed_shape_check
    CHECK (status<>'fechado' OR (
      commercial_outcome='fechado' AND sale_value IS NOT NULL AND sale_value>0
    )),
  ADD CONSTRAINT scheduling_leads_lost_shape_check
    CHECK (status<>'perdido' OR (commercial_outcome='nao_avancou' AND loss_reason IS NOT NULL)),
  ADD CONSTRAINT scheduling_leads_terminal_outcome_check
    CHECK ((commercial_outcome IS DISTINCT FROM 'fechado' OR status='fechado')
       AND (commercial_outcome IS DISTINCT FROM 'nao_avancou' OR status='perdido'));

-- Recover the first known human assignment as SDR attribution where possible.
WITH first_assignment AS (
  SELECT DISTINCT ON (event.tenant_id,event.lead_id)
         event.tenant_id,event.lead_id,member.id member_id
  FROM scheduling_lead_events event
  JOIN workspace_members member
    ON member.workspace_id=event.tenant_id
   AND member.id::text=event.details->>'responsavel_novo_member_id'
  ORDER BY event.tenant_id,event.lead_id,event.created_at,event.id
)
UPDATE scheduling_leads lead
SET sdr_member_id=first_assignment.member_id
FROM first_assignment
WHERE lead.tenant_id=first_assignment.tenant_id
  AND lead.id=first_assignment.lead_id
  AND lead.sdr_member_id IS NULL;

-- Leads without a recoverable assignment-event history keep their current owner.
UPDATE scheduling_leads
SET sdr_member_id=assigned_member_id
WHERE sdr_member_id IS NULL AND assigned_member_id IS NOT NULL;

WITH latest AS (
  SELECT DISTINCT ON (appointment.tenant_id,appointment.lead_id)
         appointment.tenant_id,appointment.lead_id,
         appointment.assigned_member_id member_id,
         COALESCE(appointment.assigned_at,appointment.created_at) assigned_at
  FROM scheduling_appointments appointment
  WHERE appointment.assigned_member_id IS NOT NULL
  ORDER BY appointment.tenant_id,appointment.lead_id,appointment.created_at DESC,appointment.id DESC
)
UPDATE scheduling_leads lead
SET closer_member_id=latest.member_id,
    handoff_at=COALESCE(lead.handoff_at,latest.assigned_at)
FROM latest
WHERE lead.tenant_id=latest.tenant_id AND lead.id=latest.lead_id
  AND lead.closer_member_id IS NULL;

UPDATE scheduling_appointments appointment
SET created_by_user_id=member.user_id
FROM workspace_members member
WHERE appointment.created_by_user_id IS NULL
  AND member.workspace_id=appointment.tenant_id
  AND member.id=appointment.assigned_member_id;

-- Historical concluded meetings had no result model. Preserve that uncertainty
-- as explicit metadata instead of fabricating a commercial result. The
-- temporary legacy marker remains accepted by the database check only for
-- rows migrated here; all new writes use the structured command service.
UPDATE scheduling_appointments
SET outcome_metadata=jsonb_build_object('legacy_result_unknown',true),
    finalized_at=COALESCE(updated_at,created_at)
WHERE status='concluido' AND commercial_outcome IS NULL;

ALTER TABLE scheduling_appointments
  ADD CONSTRAINT scheduling_appointments_commercial_outcome_check
    CHECK (commercial_outcome IS NULL OR commercial_outcome IN (
      'fechado','proposta_enviada','em_negociacao','follow_up','nao_avancou'
    )),
  ADD CONSTRAINT scheduling_appointments_loss_reason_check
    CHECK (loss_reason IS NULL OR loss_reason IN (
      'preco','sem_interesse','sem_momento','nao_qualificado',
      'concorrente','sem_retorno','outro'
    )),
  ADD CONSTRAINT scheduling_appointments_cancellation_disposition_check
    CHECK (cancellation_disposition IS NULL OR cancellation_disposition IN ('recover','lost')),
  ADD CONSTRAINT scheduling_appointments_concluded_outcome_check
    CHECK (status<>'concluido' OR commercial_outcome IS NOT NULL
      OR COALESCE((outcome_metadata->>'legacy_result_unknown')::boolean,false)),
  ADD CONSTRAINT scheduling_appointments_outcome_status_check
    CHECK (commercial_outcome IS NULL OR status='concluido'),
  ADD CONSTRAINT scheduling_appointments_result_pending_status_check
    CHECK (result_pending_at IS NULL OR status IN ('confirmado','reagendado')),
  ADD CONSTRAINT scheduling_appointments_outcome_shape_check CHECK (
    (commercial_outcome IS NULL) OR
    (commercial_outcome='fechado' AND sale_value IS NOT NULL AND sale_value>0 AND loss_reason IS NULL
      AND outcome_next_action IS NULL AND outcome_next_action_at IS NULL) OR
    (commercial_outcome IN ('proposta_enviada','em_negociacao','follow_up')
      AND sale_value IS NULL AND loss_reason IS NULL
      AND nullif(btrim(outcome_next_action),'') IS NOT NULL
      AND outcome_next_action_at IS NOT NULL) OR
    (commercial_outcome='nao_avancou' AND sale_value IS NULL
      AND loss_reason IS NOT NULL AND outcome_next_action IS NULL
      AND outcome_next_action_at IS NULL)
  ),
  ADD CONSTRAINT scheduling_appointments_cancellation_shape_check CHECK (
    cancellation_disposition IS NULL OR
    (status='cancelado' AND commercial_outcome IS NULL AND (
      (cancellation_disposition='recover' AND loss_reason IS NULL
        AND nullif(btrim(outcome_next_action),'') IS NOT NULL
        AND outcome_next_action_at IS NOT NULL) OR
      (cancellation_disposition='lost' AND loss_reason IS NOT NULL
        AND outcome_next_action IS NULL AND outcome_next_action_at IS NULL)
    ))
  );

CREATE INDEX idx_scheduling_leads_sdr
  ON scheduling_leads(tenant_id,sdr_member_id,updated_at DESC)
  WHERE sdr_member_id IS NOT NULL;
CREATE INDEX idx_scheduling_leads_closer
  ON scheduling_leads(tenant_id,closer_member_id,updated_at DESC)
  WHERE closer_member_id IS NOT NULL;
CREATE INDEX idx_scheduling_leads_recovery
  ON scheduling_leads(tenant_id,recovery_member_id,next_action_at,id)
  WHERE recovery_required;
CREATE INDEX idx_scheduling_leads_commercial
  ON scheduling_leads(tenant_id,status,commercial_outcome,commercial_updated_at DESC);
CREATE INDEX idx_scheduling_appointments_result_pending
  ON scheduling_appointments(tenant_id,result_pending_at,id)
  WHERE result_pending_at IS NOT NULL AND status IN ('confirmado','reagendado');
CREATE INDEX idx_scheduling_appointments_commercial_outcome
  ON scheduling_appointments(tenant_id,commercial_outcome,finalized_at DESC)
  WHERE commercial_outcome IS NOT NULL;
