-- Lixeira de contatos: soft delete de leads (specs/active/v6-evolucao-estrutural-atendon.md,
-- contrato "Lixeira"). Aditiva e idempotente. Contato removido ganha deleted_at/
-- deleted_by e sai de todas as listas/detalhes/joins; restore limpa as colunas.
-- A exclusão definitiva (purge) permanece manual, apenas pela rota de gestão.
-- ROLLBACK (manual, não executar automaticamente):
-- DROP INDEX IF EXISTS idx_scheduling_leads_trash;
-- ALTER TABLE scheduling_leads DROP COLUMN IF EXISTS deleted_by;
-- ALTER TABLE scheduling_leads DROP COLUMN IF EXISTS deleted_at;
-- DELETE FROM permissions WHERE key='trash.manage';

ALTER TABLE scheduling_leads ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE scheduling_leads ADD COLUMN IF NOT EXISTS deleted_by UUID
  REFERENCES users(id) ON DELETE SET NULL;

-- Lista da lixeira (removidos mais recentemente primeiro) e checagens pontuais.
CREATE INDEX IF NOT EXISTS idx_scheduling_leads_trash
  ON scheduling_leads(tenant_id, deleted_at DESC, id DESC)
  WHERE deleted_at IS NOT NULL;

-- trash.manage: dono/admin/gestão veem a lixeira, restauram e apagam de vez.
INSERT INTO permissions(key,module,action,description) VALUES
 ('trash.manage','trash','manage','Gerenciar a lixeira de contatos (visualizar, restaurar e excluir definitivamente)')
ON CONFLICT(key) DO UPDATE SET module=EXCLUDED.module,action=EXCLUDED.action,description=EXCLUDED.description;

INSERT INTO workspace_role_permissions(role_id,permission_key)
SELECT r.id,'trash.manage'
FROM workspace_roles r
WHERE r.name IN ('OWNER','ADMIN','SUPERVISOR')
ON CONFLICT DO NOTHING;

-- Retenção automática (purga por idade) foi adiada de propósito: sem política
-- de retenção definida no spec, a exclusão definitiva é apenas manual via
-- DELETE /trash/leads/:id (registro de decisão, nenhum job aqui).
