INSERT INTO permissions(key,module,action,description)
VALUES
  ('appointments.notes.manage','appointments','notes_manage','Gerenciar observações de agendamentos')
ON CONFLICT(key) DO UPDATE SET
  module=EXCLUDED.module,
  action=EXCLUDED.action,
  description=EXCLUDED.description;

INSERT INTO workspace_roles(workspace_id,name,description,is_owner_role,is_system)
SELECT id,'SUPERVISOR','Supervisao operacional com visibilidade de toda a equipe',false,true
FROM tenants
ON CONFLICT(workspace_id,name) DO UPDATE SET
  description=EXCLUDED.description,
  is_owner_role=false,
  is_system=true,
  updated_at=now();

DELETE FROM workspace_role_permissions permission
USING workspace_roles role
WHERE permission.role_id=role.id
  AND role.name='SUPERVISOR'
  AND NOT (
    permission.permission_key=ANY(ARRAY[
      'dashboard.read',
      'conversations.read',
      'conversations.reply',
      'conversations.reactivate',
      'contacts.read',
      'leads.read',
      'leads.create',
      'leads.update_status',
      'leads.transfer',
      'leads.follow_up.read',
      'leads.follow_up.manage',
      'appointments.read',
      'appointments.create',
      'appointments.reschedule',
      'appointments.cancel',
      'appointments.complete',
      'appointments.no_show',
      'appointments.notes.manage',
      'categories.read',
      'partners.read',
      'units.read',
      'availability.read',
      'signature.read'
    ]::text[])
  );

INSERT INTO workspace_role_permissions(role_id,permission_key)
SELECT role.id,permission.key
FROM workspace_roles role
JOIN permissions permission ON permission.key=ANY(ARRAY[
  'dashboard.read',
  'conversations.read',
  'conversations.reply',
  'conversations.reactivate',
  'contacts.read',
  'leads.read',
  'leads.create',
  'leads.update_status',
  'leads.transfer',
  'leads.follow_up.read',
  'leads.follow_up.manage',
  'appointments.read',
  'appointments.create',
  'appointments.reschedule',
  'appointments.cancel',
  'appointments.complete',
  'appointments.no_show',
  'appointments.notes.manage',
  'categories.read',
  'partners.read',
  'units.read',
  'availability.read',
  'signature.read'
]::text[])
WHERE role.name='SUPERVISOR'
ON CONFLICT DO NOTHING;

INSERT INTO workspace_role_permissions(role_id,permission_key)
SELECT role.id,permission.key
FROM workspace_roles role
JOIN permissions permission ON permission.key=ANY(ARRAY[
  'leads.create',
  'appointments.notes.manage'
]::text[])
WHERE role.name='OPERADOR'
ON CONFLICT DO NOTHING;
