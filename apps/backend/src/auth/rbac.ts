import type { PoolClient } from "pg";

export const PERMISSIONS = [
  { key: "dashboard.read", module: "platform", action: "read", description: "Visualizar painel" },
  { key: "workspace.read", module: "workspace", action: "read", description: "Visualizar workspace" },
  { key: "workspace.update", module: "workspace", action: "update", description: "Editar workspace" },
  { key: "members.read", module: "members", action: "read", description: "Visualizar membros" },
  { key: "members.invite", module: "members", action: "invite", description: "Convidar membros" },
  { key: "members.update", module: "members", action: "update", description: "Editar membros" },
  { key: "members.remove", module: "members", action: "remove", description: "Remover membros" },
  { key: "roles.read", module: "roles", action: "read", description: "Visualizar funcoes" },
  { key: "roles.create", module: "roles", action: "create", description: "Criar funcoes" },
  { key: "roles.update", module: "roles", action: "update", description: "Editar funcoes" },
  { key: "roles.delete", module: "roles", action: "delete", description: "Excluir funcoes" },
  { key: "audit.read", module: "audit", action: "read", description: "Visualizar auditoria" },
  { key: "api_keys.read", module: "api_keys", action: "read", description: "Visualizar chaves de API" },
  { key: "api_keys.manage", module: "api_keys", action: "manage", description: "Criar, rotacionar e revogar chaves de API" },
  { key: "connection.read", module: "connection", action: "read", description: "Visualizar conexao WhatsApp" },
  { key: "connection.manage", module: "connection", action: "manage", description: "Gerenciar conexao WhatsApp" },
  { key: "conversations.read", module: "conversations", action: "read", description: "Visualizar conversas" },
  { key: "conversations.reply", module: "conversations", action: "reply", description: "Responder conversas" },
  { key: "conversations.reactivate", module: "conversations", action: "reactivate", description: "Reativar IA em conversas" },
  { key: "contacts.read", module: "contacts", action: "read", description: "Visualizar contatos" },
  { key: "contacts.delete", module: "contacts", action: "delete", description: "Excluir contatos" },
  { key: "leads.read", module: "leads", action: "read", description: "Visualizar leads" },
  { key: "leads.create", module: "leads", action: "create", description: "Criar leads" },
  { key: "leads.update_status", module: "leads", action: "update_status", description: "Alterar status de leads" },
  { key: "leads.transfer", module: "leads", action: "transfer", description: "Transferir leads" },
  { key: "leads.send_partner_proposal", module: "leads", action: "send_partner_proposal", description: "Enviar proposta de parceiro" },
  { key: "leads.follow_up.read", module: "leads", action: "follow_up_read", description: "Visualizar acompanhamento interno de leads" },
  { key: "leads.follow_up.manage", module: "leads", action: "follow_up_manage", description: "Gerenciar acompanhamento interno de leads" },
  { key: "leads.delete", module: "leads", action: "delete", description: "Excluir leads e todo o historico de agendamentos vinculado" },
  { key: "appointments.read", module: "appointments", action: "read", description: "Visualizar agenda" },
  { key: "appointments.create", module: "appointments", action: "create", description: "Criar agendamentos" },
  { key: "appointments.reschedule", module: "appointments", action: "reschedule", description: "Reagendar" },
  { key: "appointments.cancel", module: "appointments", action: "cancel", description: "Cancelar agendamentos" },
  { key: "appointments.complete", module: "appointments", action: "complete", description: "Concluir agendamentos" },
  { key: "appointments.no_show", module: "appointments", action: "no_show", description: "Registrar não comparecimento" },
  { key: "appointments.notes.manage", module: "appointments", action: "notes_manage", description: "Gerenciar observações de agendamentos" },
  { key: "categories.read", module: "categories", action: "read", description: "Visualizar categorias" },
  { key: "categories.manage", module: "categories", action: "manage", description: "Gerenciar categorias" },
  { key: "partners.read", module: "partners", action: "read", description: "Visualizar parceiros" },
  { key: "partners.manage", module: "partners", action: "manage", description: "Gerenciar parceiros" },
  { key: "units.read", module: "units", action: "read", description: "Visualizar unidades" },
  { key: "units.manage", module: "units", action: "manage", description: "Gerenciar unidades" },
  { key: "availability.read", module: "availability", action: "read", description: "Visualizar disponibilidade" },
  { key: "availability.manage", module: "availability", action: "manage", description: "Gerenciar disponibilidade" },
  { key: "agent.read", module: "agent", action: "read", description: "Visualizar agente" },
  { key: "agent.manage", module: "agent", action: "manage", description: "Gerenciar agente" },
  { key: "humanizer.read", module: "humanizer", action: "read", description: "Visualizar humanizacao" },
  { key: "humanizer.manage", module: "humanizer", action: "manage", description: "Gerenciar humanizacao" },
  { key: "usage.read", module: "usage", action: "read", description: "Visualizar uso de IA" },
  { key: "usage.export", module: "usage", action: "export", description: "Exportar uso de IA" },
  { key: "signature.read", module: "signature", action: "read", description: "Visualizar configuracao de assinatura do atendente" },
  { key: "signature.manage", module: "signature", action: "manage", description: "Gerenciar configuracao de assinatura do atendente" },
  { key: "scheduling_notifications.read", module: "scheduling_notifications", action: "read", description: "Visualizar notificacao de agendamento no grupo de WhatsApp" },
  { key: "scheduling_notifications.manage", module: "scheduling_notifications", action: "manage", description: "Gerenciar notificacao de agendamento no grupo de WhatsApp" },
  { key: "tags.apply", module: "organization", action: "tags_apply", description: "Aplicar e remover etiquetas de leads" },
  { key: "tags.manage", module: "organization", action: "tags_manage", description: "Administrar o catalogo de etiquetas" },
  { key: "pipeline.manage", module: "organization", action: "pipeline_manage", description: "Administrar etapas e transicoes do Pipeline" },
  { key: "saved_views.publish", module: "organization", action: "saved_views_publish", description: "Publicar visoes compartilhadas" },
  { key: "post_sales.use", module: "post_sales", action: "use", description: "Visualizar e operar a carteira de pós-venda" },
  { key: "post_sales.manage", module: "post_sales", action: "manage", description: "Configurar o checklist de pós-venda" },
  { key: "tripz_ai.use", module: "tripz_ai", action: "use", description: "Usar o copiloto Tripz IA" },
  { key: "tripz_ai.manage", module: "tripz_ai", action: "manage", description: "Gerenciar propostas Tripz IA do workspace" }
] as const;

export type PermissionKey = typeof PERMISSIONS[number]["key"];

export const OPERATOR_PERMISSIONS: PermissionKey[] = [
  "dashboard.read",
  "conversations.read",
  "conversations.reply",
  "conversations.reactivate",
  "contacts.read",
  "leads.read",
  "leads.create",
  "leads.update_status",
  "leads.transfer",
  "leads.follow_up.read",
  "leads.follow_up.manage",
  "appointments.read",
  "appointments.create",
  "appointments.reschedule",
  "appointments.cancel",
  "appointments.complete",
  "appointments.no_show",
  "appointments.notes.manage",
  "categories.read",
  "partners.read",
  "units.read",
  "availability.read",
  "signature.read",
  "tags.apply",
  "post_sales.use"
];

export const SUPERVISOR_PERMISSIONS: PermissionKey[] = [
  ...OPERATOR_PERMISSIONS,
  "tags.manage",
  "pipeline.manage",
  "saved_views.publish",
  "leads.delete"
];

export async function ensurePermissionCatalog(client: PoolClient) {
  for (const permission of PERMISSIONS) {
    await client.query(
      `INSERT INTO permissions(key,module,action,description)
       VALUES($1,$2,$3,$4)
       ON CONFLICT(key) DO UPDATE SET module=EXCLUDED.module,action=EXCLUDED.action,description=EXCLUDED.description`,
      [permission.key, permission.module, permission.action, permission.description]
    );
  }
}

export async function ensureWorkspaceDefaultRoles(client: PoolClient, workspaceId: string) {
  await ensurePermissionCatalog(client);
  await client.query(
    `INSERT INTO workspace_roles(workspace_id,name,description,is_owner_role,is_system)
     VALUES
       ($1,'OWNER','Proprietario protegido do workspace',true,true),
       ($1,'ADMIN','Administrador do workspace',false,true),
       ($1,'SUPERVISOR','Supervisao operacional com visibilidade de toda a equipe',false,true),
       ($1,'OPERADOR','Operacao de atendimento e agenda',false,true)
     ON CONFLICT(workspace_id,name) DO UPDATE SET
       description=EXCLUDED.description,
       is_owner_role=EXCLUDED.is_owner_role,
       is_system=EXCLUDED.is_system,
       updated_at=now()`,
    [workspaceId]
  );
  await client.query(
    `DELETE FROM workspace_role_permissions permission
     USING workspace_roles role
     WHERE permission.role_id=role.id
       AND role.workspace_id=$1
       AND role.name='SUPERVISOR'
       AND permission.permission_key NOT IN ('tripz_ai.use','tripz_ai.manage')
       AND NOT (permission.permission_key=ANY($2::text[]))`,
    [workspaceId, SUPERVISOR_PERMISSIONS]
  );
  await client.query(
     `INSERT INTO workspace_role_permissions(role_id,permission_key)
     SELECT r.id,p.key FROM workspace_roles r CROSS JOIN permissions p
     WHERE r.workspace_id=$1 AND r.name IN ('OWNER','ADMIN')
       AND p.module <> 'tripz_ai'
     ON CONFLICT DO NOTHING`,
    [workspaceId]
  );
  await client.query(
    `INSERT INTO workspace_role_permissions(role_id,permission_key)
     SELECT r.id,permission_key FROM workspace_roles r
     CROSS JOIN unnest($2::text[]) AS permission_key
     WHERE r.workspace_id=$1 AND r.name='OPERADOR'
     ON CONFLICT DO NOTHING`,
    [workspaceId, OPERATOR_PERMISSIONS]
  );
  await client.query(
    `INSERT INTO workspace_role_permissions(role_id,permission_key)
     SELECT r.id,permission_key FROM workspace_roles r
     CROSS JOIN unnest($2::text[]) AS permission_key
     WHERE r.workspace_id=$1 AND r.name='SUPERVISOR'
     ON CONFLICT DO NOTHING`,
    [workspaceId, SUPERVISOR_PERMISSIONS]
  );
}
