INSERT INTO permissions(key,module,action,description)
VALUES
  ('leads.delete','leads','delete','Excluir leads e todo o histórico de agendamentos vinculado')
ON CONFLICT(key) DO UPDATE SET
  module=EXCLUDED.module,action=EXCLUDED.action,description=EXCLUDED.description;

INSERT INTO workspace_role_permissions(role_id,permission_key)
SELECT role.id,permission.key
FROM workspace_roles role
JOIN permissions permission ON permission.key='leads.delete'
WHERE role.name IN ('OWNER','ADMIN','SUPERVISOR')
ON CONFLICT DO NOTHING;
