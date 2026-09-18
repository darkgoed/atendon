-- Tarefas internas por workspace (specs/active/v6-evolucao-estrutural-atendon.md,
-- R6 e contrato de API "Tarefas"). Aditiva e idempotente.
-- ROLLBACK (manual, não executar automaticamente):
-- DROP TABLE IF EXISTS tasks;
-- DELETE FROM permissions WHERE key IN ('tasks.read','tasks.assign');

CREATE TABLE IF NOT EXISTS tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'aberta'
    CHECK (status IN ('aberta','em_andamento','concluida')),
  priority TEXT NOT NULL DEFAULT 'media'
    CHECK (priority IN ('baixa','media','alta')),
  due_at TIMESTAMPTZ,
  -- Responsável é um usuário do workspace; a validação de membership é feita
  -- no serviço (assignee precisa ser membro ativo do mesmo tenant).
  assignee_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_by UUID NOT NULL REFERENCES users(id),
  lead_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  -- Mesmo padrão composto (lead_id, tenant_id) das demais tabelas que apontam
  -- para scheduling_leads; contato removido definitivamente da lixeira apenas
  -- desvincula a tarefa (não a destrói).
  CONSTRAINT tasks_lead_tenant_fkey FOREIGN KEY (lead_id, tenant_id)
    REFERENCES scheduling_leads(id, tenant_id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_tenant_assignee_status
  ON tasks(tenant_id, assignee_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_tenant_lead
  ON tasks(tenant_id, lead_id);

-- Catálogo de permissões do módulo. OWNER/ADMIN recebem via cross join com o
-- catálogo (rbac.ts); SUPERVISOR recebe tasks.assign (gestão de equipe) e
-- OPERADOR apenas tasks.read. Espelha o padrão de 0154_conversation_queues.sql.
INSERT INTO permissions(key,module,action,description) VALUES
 ('tasks.read','tasks','read','Visualizar tarefas'),
 ('tasks.assign','tasks','assign','Atribuir, reatribuir e gerenciar tarefas da equipe')
ON CONFLICT(key) DO UPDATE SET module=EXCLUDED.module,action=EXCLUDED.action,description=EXCLUDED.description;

INSERT INTO workspace_role_permissions(role_id,permission_key)
SELECT r.id,p.key
FROM workspace_roles r
CROSS JOIN (VALUES ('tasks.read'),('tasks.assign')) AS p(key)
WHERE r.name IN ('OWNER','ADMIN','SUPERVISOR')
ON CONFLICT DO NOTHING;

INSERT INTO workspace_role_permissions(role_id,permission_key)
SELECT r.id,'tasks.read'
FROM workspace_roles r
WHERE r.name='OPERADOR'
ON CONFLICT DO NOTHING;
