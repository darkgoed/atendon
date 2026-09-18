-- R4 — Armazenamento da empresa (specs/active/v6-evolucao-estrutural-atendon.md).
-- Quota por tenant (tenants.storage_quota_bytes; NULL = sem limite próprio/plano),
-- contador materializado de uso (tenant_storage_usage) somado por
-- recalculateStorageUsage a partir das tabelas que guardam bytes hoje:
-- ai_stickers, ai_follow_up_media_assets, instagram_media, tripz_ai_attachments
-- e tenants.logo_data. Política de retenção (tenants.storage_retention_days;
-- NULL = sem autoexclusão) é executada EXCLUSIVAMENTE pelo job diário no
-- worker — este arquivo não deleta nada. Aditiva e idempotente.
-- ROLLBACK (manual, não executar automaticamente):
-- DROP TABLE IF EXISTS tenant_storage_usage;
-- ALTER TABLE tenants DROP COLUMN IF EXISTS storage_quota_bytes;
-- ALTER TABLE tenants DROP COLUMN IF EXISTS storage_retention_days;
-- DELETE FROM permissions WHERE key='storage.manage';

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS storage_quota_bytes BIGINT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS storage_retention_days INTEGER;

COMMENT ON COLUMN tenants.storage_quota_bytes IS
  'Quota de armazenamento da empresa em bytes; NULL = sem limite próprio (plano)';
COMMENT ON COLUMN tenants.storage_retention_days IS
  'Retenção de mídias armazenadas: excluir assets criados há mais de N dias; NULL = sem autoexclusão';

CREATE TABLE IF NOT EXISTS tenant_storage_usage (
  tenant_id UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  used_bytes BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE tenant_storage_usage IS
  'Uso de armazenamento materializado por tenant (bytes); ajustado em cada upload e recalculado por recalculateStorageUsage';

-- Seed inicial: todo tenant existente começa em 0; o primeiro recalculate
-- (GET /organization/storage, job diário ou exclusão) reconcilia com os
-- bytes reais.
INSERT INTO tenant_storage_usage(tenant_id,used_bytes)
SELECT id,0 FROM tenants
ON CONFLICT(tenant_id) DO NOTHING;

-- Gestão de armazenamento é de gestores (espelho de pipeline.manage:
-- OWNER/ADMIN/SUPERVISOR). Workspaces novos recebem a permissão via
-- ensureWorkspaceDefaultRoles (rbac.ts).
INSERT INTO permissions(key,module,action,description) VALUES
 ('storage.manage','storage','manage','Visualizar e configurar o armazenamento do workspace (quota e retenção)')
ON CONFLICT(key) DO UPDATE SET module=EXCLUDED.module,action=EXCLUDED.action,description=EXCLUDED.description;

INSERT INTO workspace_role_permissions(role_id,permission_key)
SELECT r.id,p.key
FROM workspace_roles r
CROSS JOIN (VALUES ('storage.manage')) AS p(key)
WHERE r.name IN ('OWNER','ADMIN','SUPERVISOR')
ON CONFLICT DO NOTHING;
