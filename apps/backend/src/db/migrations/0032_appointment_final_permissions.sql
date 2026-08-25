INSERT INTO permissions(key,module,action,description) VALUES
  ('appointments.complete','appointments','complete','Concluir agendamentos'),
  ('appointments.no_show','appointments','no_show','Registrar não comparecimento')
ON CONFLICT(key) DO UPDATE SET
  module=EXCLUDED.module,
  action=EXCLUDED.action,
  description=EXCLUDED.description;

INSERT INTO workspace_role_permissions(role_id,permission_key)
SELECT r.id,p.key
FROM workspace_roles r
JOIN permissions p ON p.key IN ('appointments.complete','appointments.no_show')
WHERE r.name IN ('OWNER','ADMIN','OPERADOR')
ON CONFLICT DO NOTHING;
