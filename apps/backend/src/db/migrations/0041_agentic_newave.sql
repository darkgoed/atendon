-- O formulário determinístico foi aposentado. As tabelas históricas permanecem
-- para compatibilidade/auditoria, mas nenhum fluxo legado pode continuar ativo.
UPDATE qualification_flows
SET active = false, updated_at = now()
WHERE active;

ALTER TABLE agent_configs
  ADD COLUMN IF NOT EXISTS enabled_tools JSONB NOT NULL DEFAULT '[
    "consultar_categorias",
    "consultar_parceiros",
    "consultar_unidades",
    "registrar_lead",
    "verificar_horarios",
    "agendar_visita",
    "reagendar_visita",
    "cancelar_visita",
    "enviar_proposta_parceiro",
    "atualizar_status_lead",
    "pesquisar_modelo",
    "transferir_atendente"
  ]'::jsonb;

ALTER TABLE agent_configs
  DROP CONSTRAINT IF EXISTS agent_configs_enabled_tools_array;
ALTER TABLE agent_configs
  ADD CONSTRAINT agent_configs_enabled_tools_array
  CHECK (jsonb_typeof(enabled_tools) = 'array');

ALTER TABLE scheduling_leads
  ADD COLUMN IF NOT EXISTS qualification_stars SMALLINT,
  ADD COLUMN IF NOT EXISTS qualification_answers JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS qualification_summary TEXT,
  ADD COLUMN IF NOT EXISTS qualification_reason TEXT,
  ADD COLUMN IF NOT EXISTS qualification_evaluated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS requires_human_decision BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS facebook_attribution JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE scheduling_leads
  DROP CONSTRAINT IF EXISTS scheduling_leads_qualification_stars_check;
ALTER TABLE scheduling_leads
  ADD CONSTRAINT scheduling_leads_qualification_stars_check
  CHECK (qualification_stars IS NULL OR qualification_stars BETWEEN 1 AND 5);

ALTER TABLE scheduling_leads
  DROP CONSTRAINT IF EXISTS scheduling_leads_qualification_answers_object;
ALTER TABLE scheduling_leads
  ADD CONSTRAINT scheduling_leads_qualification_answers_object
  CHECK (jsonb_typeof(qualification_answers) = 'object');

ALTER TABLE scheduling_leads
  DROP CONSTRAINT IF EXISTS scheduling_leads_facebook_attribution_object;
ALTER TABLE scheduling_leads
  ADD CONSTRAINT scheduling_leads_facebook_attribution_object
  CHECK (jsonb_typeof(facebook_attribution) = 'object');

-- Preserva a atribuição segura já coletada pelo fluxo anterior, sem copiar
-- qualquer payload bruto do provedor.
UPDATE scheduling_leads l
SET facebook_attribution = q.attribution
FROM lead_qualifications q
WHERE q.lead_id = l.id
  AND q.tenant_id = l.tenant_id
  AND q.attribution <> '{}'::jsonb
  AND l.facebook_attribution = '{}'::jsonb;

-- A atribuição pode chegar antes de o agente chamar registrar_lead. A conversa
-- guarda somente o DTO normalizado e limitado produzido pelo webhook.
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS facebook_attribution JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE conversations
  DROP CONSTRAINT IF EXISTS conversations_facebook_attribution_object;
ALTER TABLE conversations
  ADD CONSTRAINT conversations_facebook_attribution_object
  CHECK (jsonb_typeof(facebook_attribution) = 'object');

CREATE INDEX IF NOT EXISTS idx_scheduling_leads_qualification_stars
  ON scheduling_leads(tenant_id, qualification_stars, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_scheduling_leads_human_decision
  ON scheduling_leads(tenant_id, updated_at DESC)
  WHERE requires_human_decision;
