-- Produto passa a nascer em modo LIVRE: leads podem ser movidos para
-- qualquer etapa do pipeline sem aresta em pipeline_transitions. O modo
-- governado (grafo de transições) continua disponível e reversível via
-- PATCH /organization/pipeline/settings (permissão pipeline.manage),
-- que grava o mesmo flag `tenants.pipeline_enforce_transitions`.
-- Nenhum DDL de coluna é executado aqui: 0156 já cria a coluna com
-- DEFAULT false; esta migration apenas troca o padrão dos tenants
-- existentes, que 0156 havia marcado como legado (true).
--
-- ROLLBACK:
--   UPDATE tenants SET pipeline_enforce_transitions=true;
DO $migration$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema='public'
      AND table_name='tenants'
      AND column_name='pipeline_enforce_transitions'
  ) THEN
    UPDATE tenants SET pipeline_enforce_transitions=false;
  END IF;
END
$migration$;
