-- 0185: Grupos opcionais de pipelines, isolados por empresa (tenant).
--   * Grupo é só um agrupador visual: nunca restringe quantidade de pipelines
--     nem participa da entrada de contatos (ordem de pipelines continua global
--     em pipelines.position via PUT /organization/pipelines/order).
--   * NADA é semeado: pipelines existentes ficam com group_id NULL e empresas
--     novas nascem sem grupos (seed mínimo de 0184 intocado).
--   * Arquivar grupo não apaga histórico: desagrupa os pipelines (group_id=NULL)
--     e some das listas; nome ativo é único por empresa.
--
-- ROLLBACK (manual; perde grupos):
--   ALTER TABLE pipelines DROP CONSTRAINT IF EXISTS pipelines_group_tenant_fkey, DROP COLUMN IF EXISTS group_id;
--   DROP TABLE IF EXISTS pipeline_groups;

CREATE TABLE IF NOT EXISTS pipeline_groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  position INTEGER NOT NULL DEFAULT 0 CHECK (position>=0),
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pipeline_groups_id_tenant_unique UNIQUE(id,tenant_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_pipeline_groups_active_name
  ON pipeline_groups(tenant_id,lower(name)) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_pipeline_groups_order
  ON pipeline_groups(tenant_id,archived_at,position,id);

ALTER TABLE pipelines ADD COLUMN IF NOT EXISTS group_id UUID;
ALTER TABLE pipelines DROP CONSTRAINT IF EXISTS pipelines_group_tenant_fkey;
ALTER TABLE pipelines
  ADD CONSTRAINT pipelines_group_tenant_fkey
  FOREIGN KEY(group_id,tenant_id) REFERENCES pipeline_groups(id,tenant_id) ON DELETE SET NULL (group_id);
CREATE INDEX IF NOT EXISTS idx_pipelines_group
  ON pipelines(tenant_id,group_id) WHERE group_id IS NOT NULL;
