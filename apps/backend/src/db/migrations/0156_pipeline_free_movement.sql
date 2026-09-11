-- Pipeline novo nasce com movimentação livre, sem remover o grafo legado,
-- pipeline_transitions, CHECKs ou o trigger que mantém etapa/status/tenant coerentes.
-- Tenants existentes são marcados como modo legado somente na primeira criação
-- da coluna; reexecutar esta migration nunca sobrescreve uma preferência salva.
--
-- ROLLBACK:
--   ALTER TABLE scheduling_leads DROP COLUMN outcome_metadata;
--   ALTER TABLE tenants DROP COLUMN pipeline_enforce_transitions;
DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema='public'
      AND table_name='tenants'
      AND column_name='pipeline_enforce_transitions'
  ) THEN
    ALTER TABLE tenants
      ADD COLUMN IF NOT EXISTS pipeline_enforce_transitions BOOLEAN NOT NULL DEFAULT false;

    UPDATE tenants SET pipeline_enforce_transitions=true;
  END IF;
END
$migration$;

COMMENT ON COLUMN tenants.pipeline_enforce_transitions IS
  'true exige DOMAIN_TRANSITIONS e aresta em pipeline_transitions ao mover leads; false dispensa somente essas restrições de sequência.';

-- Metadados comerciais do lead são distintos de
-- scheduling_appointments.outcome_metadata, que continua pertencendo ao
-- resultado de um agendamento.
ALTER TABLE scheduling_leads
  ADD COLUMN IF NOT EXISTS outcome_metadata JSONB NOT NULL DEFAULT '{}'::jsonb;
