-- RBAC drift repair. ensureWorkspaceDefaultRoles only runs when a workspace is
-- created, so workspaces provisioned before newer permissions existed never
-- received the OWNER/ADMIN default grants. Found in production: Meta Cell was
-- missing billing.manage and appointments.notes.manage; Newave and Tripz
-- Turismo were missing billing.manage — leaving OWNER/ADMIN unable to pay
-- invoices or configure usage credit. Re-applies the rbac.ts default: every
-- catalog permission except the tripz_ai module, which is granted manually per
-- workspace. Additive only (ON CONFLICT DO NOTHING), matching what default
-- provisioning would have granted at creation time.

INSERT INTO workspace_role_permissions(role_id,permission_key)
SELECT r.id, p.key
FROM workspace_roles r
CROSS JOIN permissions p
WHERE r.name IN ('OWNER','ADMIN')
  AND p.module <> 'tripz_ai'
ON CONFLICT DO NOTHING;

-- The api_keys module no longer exists in the product (its routes were
-- removed); its stale catalog rows kept being granted to OWNER/ADMIN of every
-- new workspace by the cross join above. Removing the permission rows cascades
-- to workspace_role_permissions (FK ON DELETE CASCADE).
DELETE FROM permissions WHERE key IN ('api_keys.read','api_keys.manage');

-- The connection module now covers the Instagram Direct channel as well, not
-- only WhatsApp. Mirrors the descriptions in auth/rbac.ts.
UPDATE permissions SET description='Visualizar conexões de WhatsApp e Instagram'
WHERE key='connection.read' AND description='Visualizar conexao WhatsApp';
UPDATE permissions SET description='Gerenciar conexões de WhatsApp e Instagram'
WHERE key='connection.manage' AND description='Gerenciar conexao WhatsApp';
