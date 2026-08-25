ALTER TABLE tenants ADD COLUMN IF NOT EXISTS slug TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS created_by_user_id UUID;

UPDATE tenants
SET slug = lower(regexp_replace(name, '[^a-zA-Z0-9]+', '-', 'g')) || '-' || left(id::text, 8)
WHERE slug IS NULL OR slug = '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_tenants_slug_unique ON tenants(slug);

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT,
  status TEXT NOT NULL DEFAULT 'invited' CHECK (status IN ('invited', 'active', 'disabled')),
  is_root BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS permissions (
  key TEXT PRIMARY KEY,
  module TEXT NOT NULL,
  action TEXT NOT NULL,
  description TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workspace_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  is_owner_role BOOLEAN NOT NULL DEFAULT false,
  is_system BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(workspace_id,name)
);

CREATE TABLE IF NOT EXISTS workspace_role_permissions (
  role_id UUID NOT NULL REFERENCES workspace_roles(id) ON DELETE CASCADE,
  permission_key TEXT NOT NULL REFERENCES permissions(key) ON DELETE CASCADE,
  PRIMARY KEY(role_id,permission_key)
);

CREATE TABLE IF NOT EXISTS workspace_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id UUID NOT NULL REFERENCES workspace_roles(id),
  status TEXT NOT NULL DEFAULT 'invited' CHECK (status IN ('invited', 'active', 'suspended')),
  joined_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(workspace_id,user_id)
);

CREATE TABLE IF NOT EXISTS workspace_invitations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role_id UUID NOT NULL REFERENCES workspace_roles(id),
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'revoked', 'expired')),
  expires_at TIMESTAMPTZ NOT NULL,
  invited_by_user_id UUID NOT NULL REFERENCES users(id),
  accepted_by_user_id UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  accepted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id UUID REFERENCES users(id),
  workspace_id UUID REFERENCES tenants(id) ON DELETE SET NULL,
  actor_scope TEXT NOT NULL CHECK (actor_scope IN ('root', 'workspace')),
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}',
  ip_address TEXT,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_workspace_members_user ON workspace_members(user_id);
CREATE INDEX IF NOT EXISTS idx_workspace_members_workspace ON workspace_members(workspace_id);
CREATE INDEX IF NOT EXISTS idx_workspace_invitations_workspace ON workspace_invitations(workspace_id,status);
CREATE INDEX IF NOT EXISTS idx_audit_logs_workspace_date ON audit_logs(workspace_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor_date ON audit_logs(actor_user_id,created_at DESC);

INSERT INTO permissions(key,module,action,description) VALUES
  ('dashboard.read','platform','read','Visualizar painel'),
  ('workspace.read','workspace','read','Visualizar workspace'),
  ('workspace.update','workspace','update','Editar workspace'),
  ('members.read','members','read','Visualizar membros'),
  ('members.invite','members','invite','Convidar membros'),
  ('members.update','members','update','Editar membros'),
  ('members.remove','members','remove','Remover membros'),
  ('roles.read','roles','read','Visualizar funcoes'),
  ('roles.create','roles','create','Criar funcoes'),
  ('roles.update','roles','update','Editar funcoes'),
  ('roles.delete','roles','delete','Excluir funcoes'),
  ('audit.read','audit','read','Visualizar auditoria'),
  ('connection.read','connection','read','Visualizar conexao WhatsApp'),
  ('connection.manage','connection','manage','Gerenciar conexao WhatsApp'),
  ('conversations.read','conversations','read','Visualizar conversas'),
  ('conversations.reply','conversations','reply','Responder conversas'),
  ('conversations.reactivate','conversations','reactivate','Reativar IA em conversas'),
  ('contacts.read','contacts','read','Visualizar contatos'),
  ('contacts.delete','contacts','delete','Excluir contatos'),
  ('leads.read','leads','read','Visualizar leads'),
  ('leads.create','leads','create','Criar leads'),
  ('leads.update_status','leads','update_status','Alterar status de leads'),
  ('leads.transfer','leads','transfer','Transferir leads'),
  ('leads.send_partner_proposal','leads','send_partner_proposal','Enviar proposta de parceiro'),
  ('appointments.read','appointments','read','Visualizar agenda'),
  ('appointments.create','appointments','create','Criar agendamentos'),
  ('appointments.reschedule','appointments','reschedule','Reagendar'),
  ('appointments.cancel','appointments','cancel','Cancelar agendamentos'),
  ('categories.read','categories','read','Visualizar categorias'),
  ('categories.manage','categories','manage','Gerenciar categorias'),
  ('partners.read','partners','read','Visualizar parceiros'),
  ('partners.manage','partners','manage','Gerenciar parceiros'),
  ('units.read','units','read','Visualizar unidades'),
  ('units.manage','units','manage','Gerenciar unidades'),
  ('availability.read','availability','read','Visualizar disponibilidade'),
  ('availability.manage','availability','manage','Gerenciar disponibilidade'),
  ('agent.read','agent','read','Visualizar agente'),
  ('agent.manage','agent','manage','Gerenciar agente'),
  ('humanizer.read','humanizer','read','Visualizar humanizacao'),
  ('humanizer.manage','humanizer','manage','Gerenciar humanizacao'),
  ('usage.read','usage','read','Visualizar uso de IA'),
  ('usage.export','usage','export','Exportar uso de IA')
ON CONFLICT(key) DO UPDATE SET module=EXCLUDED.module,action=EXCLUDED.action,description=EXCLUDED.description;

DO $$
DECLARE
  collisions TEXT;
BEGIN
  SELECT string_agg(email_key, ', ')
  INTO collisions
  FROM (
    SELECT lower(email) email_key
    FROM panel_users
    GROUP BY lower(email)
    HAVING count(*) > 1
  ) duplicated;

  IF collisions IS NOT NULL THEN
    RAISE EXCEPTION 'panel_users has case-insensitive email collisions before SaaS migration: %', collisions;
  END IF;
END $$;

INSERT INTO users(email,password_hash,status,is_root,created_at,updated_at)
SELECT lower(email),password_hash,'active',bool_or(is_super_admin),min(created_at),now()
FROM panel_users
GROUP BY lower(email),password_hash
ON CONFLICT(email) DO UPDATE SET
  password_hash=COALESCE(users.password_hash,EXCLUDED.password_hash),
  is_root=users.is_root OR EXCLUDED.is_root,
  status=CASE WHEN users.status='invited' THEN 'active' ELSE users.status END,
  updated_at=now();

INSERT INTO workspace_roles(workspace_id,name,description,is_owner_role,is_system)
SELECT t.id,role.name,role.description,role.is_owner_role,true
FROM tenants t
CROSS JOIN (VALUES
  ('OWNER','Proprietario protegido do workspace',true),
  ('ADMIN','Administrador do workspace',false),
  ('OPERADOR','Operacao de atendimento e agenda',false)
) AS role(name,description,is_owner_role)
ON CONFLICT(workspace_id,name) DO UPDATE SET
  description=EXCLUDED.description,
  is_owner_role=EXCLUDED.is_owner_role,
  is_system=true,
  updated_at=now();

INSERT INTO workspace_role_permissions(role_id,permission_key)
SELECT r.id,p.key
FROM workspace_roles r
CROSS JOIN permissions p
WHERE r.name IN ('OWNER','ADMIN')
ON CONFLICT DO NOTHING;

INSERT INTO workspace_role_permissions(role_id,permission_key)
SELECT r.id,permission_key
FROM workspace_roles r
CROSS JOIN unnest(ARRAY[
  'dashboard.read',
  'conversations.read',
  'conversations.reply',
  'conversations.reactivate',
  'contacts.read',
  'leads.read',
  'leads.update_status',
  'leads.transfer',
  'appointments.read',
  'appointments.create',
  'appointments.reschedule',
  'appointments.cancel',
  'categories.read',
  'partners.read',
  'units.read',
  'availability.read'
]::text[]) AS permission_key
WHERE r.name='OPERADOR'
ON CONFLICT DO NOTHING;

INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at,created_at,updated_at)
SELECT pu.tenant_id,u.id,r.id,'active',pu.created_at,pu.created_at,now()
FROM panel_users pu
JOIN users u ON u.email=lower(pu.email)
JOIN workspace_roles r ON r.workspace_id=pu.tenant_id AND r.name=CASE WHEN pu.role='admin' THEN 'ADMIN' ELSE 'OWNER' END
ON CONFLICT(workspace_id,user_id) DO UPDATE SET
  role_id=EXCLUDED.role_id,
  status='active',
  joined_at=COALESCE(workspace_members.joined_at,EXCLUDED.joined_at),
  updated_at=now();

UPDATE tenants t
SET created_by_user_id = owners.user_id
FROM (
  SELECT DISTINCT ON (m.workspace_id) m.workspace_id,m.user_id
  FROM workspace_members m
  JOIN workspace_roles r ON r.id=m.role_id
  WHERE r.is_owner_role=true
  ORDER BY m.workspace_id,m.created_at
) owners
WHERE owners.workspace_id=t.id AND t.created_by_user_id IS NULL;
