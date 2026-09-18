-- Respostas rápidas do composer "/" (specs/active/v6-evolucao-estrutural-atendon.md,
-- R5 e contrato "Quick replies"). O backend armazena o texto cru; as variáveis
-- {{nome}}/{{atendente}}/{{data}} são resolvidas no frontend na inserção.
-- Aditiva e idempotente.
-- ROLLBACK (manual, não executar automaticamente):
-- DROP TABLE IF EXISTS quick_replies;
-- DELETE FROM permissions WHERE key IN ('quick_replies.read','quick_replies.manage');

CREATE TABLE IF NOT EXISTS quick_replies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- Atalho digitado após "/" (sem a barra), case-insensitive por tenant.
  shortcut TEXT NOT NULL,
  body TEXT NOT NULL,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT quick_replies_tenant_shortcut_unique UNIQUE (tenant_id, shortcut)
);

CREATE INDEX IF NOT EXISTS idx_quick_replies_tenant
  ON quick_replies(tenant_id, shortcut);

-- Leitura liberada para qualquer agente; escrita exige gestão
-- (convenção análoga a tags.manage: OWNER/ADMIN/SUPERVISOR).
INSERT INTO permissions(key,module,action,description) VALUES
 ('quick_replies.read','quick_replies','read','Visualizar respostas rapidas do workspace'),
 ('quick_replies.manage','quick_replies','manage','Criar, editar e excluir respostas rapidas do workspace')
ON CONFLICT(key) DO UPDATE SET module=EXCLUDED.module,action=EXCLUDED.action,description=EXCLUDED.description;

INSERT INTO workspace_role_permissions(role_id,permission_key)
SELECT r.id,p.key
FROM workspace_roles r
CROSS JOIN (VALUES ('quick_replies.read'),('quick_replies.manage')) AS p(key)
WHERE r.name IN ('OWNER','ADMIN','SUPERVISOR')
ON CONFLICT DO NOTHING;

INSERT INTO workspace_role_permissions(role_id,permission_key)
SELECT r.id,'quick_replies.read'
FROM workspace_roles r
WHERE r.name='OPERADOR'
ON CONFLICT DO NOTHING;
