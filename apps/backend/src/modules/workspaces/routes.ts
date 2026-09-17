import { compare, hash } from "bcryptjs";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { PermissionKey } from "../../auth/rbac.js";
import { createSessionToken, requirePermission, requireRootWorkspace, requireSession, type WorkspaceSession } from "../../auth/session.js";
import { db } from "../../db/client.js";
import { config } from "../../config.js";
import { getEmailProvider } from "../../mail/index.js";
import { buildInvitationAcceptUrl, createInvitationToken, sendWorkspaceInvitationEmail, shouldExposeInvitationToken } from "../../mail/invitations.js";
import { HTTP_RATE_LIMITS } from "../../security/http-rate-limit.js";
import { isValidIanaTimeZone } from "../../timezone.js";
import { httpError } from "../scheduling/service.js";
import { adjustDelayedInboundJobs } from "../../queue/message-queue.js";

const uuid = z.string().uuid();
const roleBody = z.object({
  name: z.string().trim().min(2).max(80).regex(/^[\p{L}\p{N} _-]+$/u).transform((value) => value.trim().toLocaleUpperCase("pt-BR")),
  description: z.string().trim().max(500).default(""),
  permissions: z.array(z.string().trim().min(1)).max(200).default([])
});
const roleParams = z.object({ roleId: uuid });
const memberParams = z.object({ memberId: uuid });
const invitationParams = z.object({ invitationId: uuid });
const invitationTokenParams = z.object({ token: z.string().trim().min(32).max(200) });
const inviteBody = z.object({ email: z.string().trim().email().max(254), roleId: uuid });
const updateMemberBody = z.object({ roleId: uuid.optional(), status: z.enum(["active", "suspended"]).optional() })
  .refine((value) => value.roleId || value.status, "Informe roleId ou status");
const updateMemberProfileBody = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  email: z.string().trim().email().max(254).optional(),
  newPassword: z.string().min(8).max(200).optional(),
  mustChangePassword: z.boolean().optional()
}).refine((value) => value.name || value.email || value.newPassword, "Informe nome, e-mail ou nova senha")
  .superRefine((value, context) => {
    if (value.mustChangePassword && !value.newPassword) {
      context.addIssue({
        code: "custom",
        path: ["newPassword"],
        message: "Informe uma senha temporária para exigir a troca no próximo login"
      });
    }
    if (value.newPassword && !value.mustChangePassword && value.newPassword.length < 12) {
      context.addIssue({
        code: "custom",
        path: ["newPassword"],
        message: "Uma senha definitiva deve ter ao menos 12 caracteres"
      });
    }
  });
const transferOwnerBody = z.object({ memberId: uuid });
const hhmm = z.string().trim().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use o formato HH:MM");
const timezoneBody = z.object({
  timezone: z.string().trim().min(1).max(100).refine(isValidIanaTimeZone, "Fuso horário IANA inválido"),
  business_hours_start: hhmm.optional(),
  business_hours_end: hhmm.optional()
}).refine(
  (body) => !body.business_hours_start || !body.business_hours_end || body.business_hours_start < body.business_hours_end,
  { message: "O início do horário comercial deve ser antes do fim", path: ["business_hours_end"] }
);
const invitationPassword = z.string().min(8).max(200);
const LOGO_DATA_MAX_LENGTH = 150_000;
const logoBody = z.object({
  logo_data: z.string({
    required_error: "Informe a logo como data URL",
    invalid_type_error: "A logo deve ser uma string (data URL)"
  })
    .max(LOGO_DATA_MAX_LENGTH, `A logo excede o limite de ${LOGO_DATA_MAX_LENGTH} caracteres`)
    .refine(
      (value) => /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value) && (value.length - value.indexOf(",") - 1) % 4 === 0,
      "Logo inválida: use um data URL base64 de imagem PNG, JPEG ou WEBP"
    )
});
const acceptInvitationBody = z.object({
  token: z.string().trim().min(32).max(200),
  currentPassword: invitationPassword.optional(),
  newPassword: invitationPassword.optional(),
  passwordConfirmation: invitationPassword.optional()
}).refine((body) => body.currentPassword || body.newPassword, {
  message: "Informe a senha necessária para aceitar o convite"
}).refine((body) => !body.newPassword || body.newPassword === body.passwordConfirmation, {
  message: "A confirmação da nova senha não confere",
  path: ["passwordConfirmation"]
});

function tokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

async function audit(request: FastifyRequest, input: { action: string; resourceType: string; resourceId?: string | null; metadata?: Record<string, unknown> }) {
  const session = await requireSession(request);
  await db.query(
    `INSERT INTO audit_logs(actor_user_id,workspace_id,actor_scope,action,resource_type,resource_id,metadata,ip_address,user_agent)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      session.userId,
      session.tenantId,
      session.actorScope,
      input.action,
      input.resourceType,
      input.resourceId ?? null,
      input.metadata ?? {},
      request.ip,
      typeof request.headers["user-agent"] === "string" ? request.headers["user-agent"] : null
    ]
  );
}

async function roleIsProtected(workspaceId: string, roleId: string) {
  const result = await db.query<{ is_owner_role: boolean; is_system: boolean }>(
    "SELECT is_owner_role,is_system FROM workspace_roles WHERE workspace_id=$1 AND id=$2",
    [workspaceId, roleId]
  );
  if (!result.rows[0]) throw httpError(404, "Função não encontrada");
  return result.rows[0].is_owner_role || result.rows[0].is_system;
}

function assertPermissionsGrantable(session: WorkspaceSession, permissions: string[]) {
  if (session.isRoot && session.rootWorkspaceAccess) return;
  const granted = new Set<string>(session.permissions);
  if (permissions.some((permission) => !granted.has(permission))) {
    throw httpError(403, "Não é permitido conceder privilégios superiores aos seus");
  }
}

async function assertRoleAssignable(session: WorkspaceSession, roleId: string) {
  const result = await db.query<{ name: string; is_owner_role: boolean; permissions: string[] }>(
    `SELECT r.name,r.is_owner_role,
            COALESCE(array_agg(rp.permission_key) FILTER (WHERE rp.permission_key IS NOT NULL),'{}') permissions
     FROM workspace_roles r
     LEFT JOIN workspace_role_permissions rp ON rp.role_id=r.id
     WHERE r.workspace_id=$1 AND r.id=$2
     GROUP BY r.id`,
    [session.tenantId, roleId]
  );
  const target = result.rows[0];
  if (!target) throw httpError(404, "Função não encontrada");
  if (target.is_owner_role) throw httpError(409, "OWNER exige transferência explícita de propriedade");
  if (session.isRoot && session.rootWorkspaceAccess) return;
  if (target.name === "ADMIN" && session.role !== "OWNER") {
    throw httpError(403, "Somente OWNER pode atribuir a função ADMIN");
  }
  const granted = new Set<string>(session.permissions);
  if (target.permissions.some((permission) => !granted.has(permission))) {
    throw httpError(403, "Não é permitido atribuir uma função com privilégios superiores aos seus");
  }
}

function assertCanManageMemberProfile(
  session: WorkspaceSession,
  target: { user_id: string; role_name: string; is_owner_role: boolean; is_root: boolean }
) {
  if (target.user_id === session.userId) {
    throw httpError(409, "Use a tela Perfil para alterar a própria conta");
  }
  if (session.isRoot && session.rootWorkspaceAccess) return;
  if (target.is_root) throw httpError(403, "Somente ROOT pode alterar outra conta ROOT");
  if (session.role === "OWNER" && !target.is_owner_role) return;
  if (session.role === "ADMIN" && !target.is_owner_role && target.role_name !== "ADMIN") return;
  throw httpError(403, "Seu perfil não pode alterar os dados deste membro");
}

export async function registerWorkspaceRoutes(app: FastifyInstance) {

  app.get("/workspaces/current/timezone", async (request) => {
    const session = await requirePermission(request, "workspace.update");
    const result = await db.query<{ id: string; name: string; timezone: string; business_hours_start: string; business_hours_end: string }>(
      "SELECT id,name,timezone,business_hours_start,business_hours_end FROM tenants WHERE id=$1",
      [session.tenantId]
    );
    if (!result.rows[0]) throw httpError(404, "Workspace não encontrado");
    return { workspace: result.rows[0] };
  });

  app.patch("/workspaces/current/timezone", async (request) => {
    const session = await requirePermission(request, "workspace.update");
    const body = timezoneBody.parse(request.body);
    const result = await db.query<{ id: string; name: string; timezone: string; business_hours_start: string; business_hours_end: string }>(
      `UPDATE tenants SET timezone=$2,
         business_hours_start=COALESCE($3,business_hours_start),
         business_hours_end=COALESCE($4,business_hours_end),
         updated_at=now()
       WHERE id=$1 RETURNING id,name,timezone,business_hours_start,business_hours_end`,
      [session.tenantId, body.timezone, body.business_hours_start ?? null, body.business_hours_end ?? null]
    );
    if (!result.rows[0]) throw httpError(404, "Workspace não encontrado");
    let queueAdjustment = { promoted: 0, rescheduled: 0, skipped: 0 };
    try {
      queueAdjustment = await adjustDelayedInboundJobs(session.tenantId, {
        timezone: result.rows[0].timezone,
        start: result.rows[0].business_hours_start,
        end: result.rows[0].business_hours_end
      });
    } catch (error) {
      request.log.error({ err: error, workspaceId: session.tenantId }, "Could not adjust delayed inbound jobs after business-hours update");
    }
    await audit(request, {
      action: "workspace.timezone.update",
      resourceType: "workspace",
      resourceId: session.tenantId,
      metadata: { timezone: body.timezone, business_hours_start: body.business_hours_start, business_hours_end: body.business_hours_end }
    });
    return { workspace: result.rows[0], queue_adjustment: queueAdjustment };
  });

  app.patch("/workspaces/current/logo", async (request) => {
    const session = await requirePermission(request, "workspace.update");
    const body = logoBody.parse(request.body);
    const result = await db.query<{ id: string; name: string; logo_data: string | null }>(
      `UPDATE tenants SET logo_data=$2,updated_at=now()
       WHERE id=$1 RETURNING id,name,logo_data`,
      [session.tenantId, body.logo_data]
    );
    if (!result.rows[0]) throw httpError(404, "Workspace não encontrado");
    await audit(request, {
      action: "workspace.logo.update",
      resourceType: "workspace",
      resourceId: session.tenantId,
      metadata: { logo_data_length: body.logo_data.length }
    });
    return { workspace: result.rows[0] };
  });

  app.delete("/workspaces/current/logo", async (request) => {
    const session = await requirePermission(request, "workspace.update");
    const result = await db.query<{ id: string; name: string; logo_data: string | null }>(
      `UPDATE tenants SET logo_data=NULL,updated_at=now()
       WHERE id=$1 RETURNING id,name,logo_data`,
      [session.tenantId]
    );
    if (!result.rows[0]) throw httpError(404, "Workspace não encontrado");
    await audit(request, {
      action: "workspace.logo.delete",
      resourceType: "workspace",
      resourceId: session.tenantId
    });
    return { workspace: result.rows[0] };
  });

  app.get("/workspaces/current/members", async (request) => {
    const session = await requirePermission(request, "members.read");
    const result = await db.query(
      `SELECT m.id,m.status,m.joined_at,m.created_at,u.id user_id,u.name,u.email,u.status user_status,
              u.is_root,u.must_change_password,r.id role_id,r.name role_name,r.is_owner_role
       FROM workspace_members m
       JOIN users u ON u.id=m.user_id
       JOIN workspace_roles r ON r.id=m.role_id
       WHERE m.workspace_id=$1
       ORDER BY r.is_owner_role DESC,u.email`,
      [session.tenantId]
    );
    return { members: result.rows };
  });

  app.patch("/workspaces/current/members/:memberId", async (request) => {
    const session = await requirePermission(request, "members.update");
    const { memberId } = memberParams.parse(request.params);
    const body = updateMemberBody.parse(request.body);
    const current = await db.query<{ role_id: string; is_owner_role: boolean; user_id: string }>(
      `SELECT m.role_id,m.user_id,r.is_owner_role FROM workspace_members m
       JOIN workspace_roles r ON r.id=m.role_id
       WHERE m.workspace_id=$1 AND m.id=$2`,
      [session.tenantId, memberId]
    );
    if (!current.rows[0]) throw httpError(404, "Membro não encontrado");
    if (current.rows[0].is_owner_role) throw httpError(409, "OWNER exige transferencia explicita de propriedade");
    await assertRoleAssignable(session, current.rows[0].role_id);
    if (body.roleId) await assertRoleAssignable(session, body.roleId);
    const result = await db.query(
      `UPDATE workspace_members SET
         role_id=COALESCE($3,role_id),
         status=COALESCE($4,status),
         updated_at=now()
       WHERE workspace_id=$1 AND id=$2
       RETURNING id,status,role_id,updated_at`,
      [session.tenantId, memberId, body.roleId ?? null, body.status ?? null]
    );
    await audit(request, { action: "members.update", resourceType: "workspace_member", resourceId: memberId, metadata: body });
    await db.query("UPDATE users SET session_version=session_version+1,updated_at=now() WHERE id=$1", [current.rows[0].user_id]);
    return { member: result.rows[0] };
  });

  app.patch("/workspaces/current/members/:memberId/profile", async (request) => {
    const session = await requirePermission(request, "members.update");
    const { memberId } = memberParams.parse(request.params);
    const body = updateMemberProfileBody.parse(request.body);
    const passwordHash = body.newPassword ? await hash(body.newPassword, 12) : null;
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const current = await client.query<{
        user_id: string;
        name: string | null;
        email: string;
        role_name: string;
        is_owner_role: boolean;
        is_root: boolean;
      }>(
        `SELECT m.user_id,u.name,u.email,u.is_root,r.name role_name,r.is_owner_role
         FROM workspace_members m
         JOIN users u ON u.id=m.user_id
         JOIN workspace_roles r ON r.id=m.role_id
         WHERE m.workspace_id=$1 AND m.id=$2
         FOR UPDATE OF u`,
        [session.tenantId, memberId]
      );
      const target = current.rows[0];
      if (!target) throw httpError(404, "Membro não encontrado");
      assertCanManageMemberProfile(session, target);

      const memberships = await client.query<{ count: number }>(
        "SELECT count(*)::int count FROM workspace_members WHERE user_id=$1",
        [target.user_id]
      );
      if (!session.isRoot && memberships.rows[0].count > 1) {
        throw httpError(
          409,
          "Este usuário pertence a outros workspaces; somente ROOT pode alterar sua identidade global"
        );
      }

      const nextEmail = body.email?.toLocaleLowerCase("en-US") ?? target.email;
      const credentialsChanged = Boolean(body.email || body.newPassword);
      const updated = await client.query<{
        id: string;
        name: string | null;
        email: string;
        must_change_password: boolean;
        session_version: number;
      }>(
        `UPDATE users
         SET name=COALESCE($2,name),
             email=$3,
             password_hash=COALESCE($4,password_hash),
             must_change_password=CASE WHEN $4::text IS NOT NULL THEN $5 ELSE must_change_password END,
             session_version=session_version+($6::int),
             updated_at=now()
         WHERE id=$1
         RETURNING id,name,email,must_change_password,session_version`,
        [
          target.user_id,
          body.name ?? null,
          nextEmail,
          passwordHash,
          Boolean(body.newPassword && body.mustChangePassword),
          credentialsChanged ? 1 : 0
        ]
      );

      await client.query(
        `INSERT INTO audit_logs(
           actor_user_id,workspace_id,actor_scope,action,resource_type,resource_id,
           metadata,ip_address,user_agent
         ) VALUES($1,$2,$3,'members.profile.update','workspace_member',$4,$5,$6,$7)`,
        [
          session.userId,
          session.tenantId,
          session.actorScope,
          memberId,
          {
            nameChanged: body.name !== undefined && body.name !== target.name,
            emailChanged: body.email !== undefined && nextEmail !== target.email,
            passwordReset: Boolean(body.newPassword),
            mustChangePassword: Boolean(body.newPassword && body.mustChangePassword)
          },
          request.ip,
          typeof request.headers["user-agent"] === "string"
            ? request.headers["user-agent"]
            : null
        ]
      );
      await client.query("COMMIT");
      return { member: updated.rows[0] };
    } catch (error) {
      await client.query("ROLLBACK");
      if (typeof error === "object" && error && "code" in error && error.code === "23505") {
        throw httpError(409, "Este e-mail já está em uso");
      }
      throw error;
    } finally {
      client.release();
    }
  });

  app.delete("/workspaces/current/members/:memberId", async (request, reply) => {
    const session = await requirePermission(request, "members.remove");
    const { memberId } = memberParams.parse(request.params);
    const current = await db.query<{ role_id: string; is_owner_role: boolean; user_id: string }>(
      `SELECT m.role_id,m.user_id,r.is_owner_role FROM workspace_members m
       JOIN workspace_roles r ON r.id=m.role_id
       WHERE m.workspace_id=$1 AND m.id=$2`,
      [session.tenantId, memberId]
    );
    if (!current.rows[0]) throw httpError(404, "Membro não encontrado");
    if (current.rows[0].is_owner_role) throw httpError(409, "OWNER não pode ser removido por edição comum");
    await assertRoleAssignable(session, current.rows[0].role_id);
    await db.query("DELETE FROM workspace_members WHERE workspace_id=$1 AND id=$2", [session.tenantId, memberId]);
    await audit(request, { action: "members.remove", resourceType: "workspace_member", resourceId: memberId });
    await db.query("UPDATE users SET session_version=session_version+1,updated_at=now() WHERE id=$1", [current.rows[0].user_id]);
    return reply.status(204).send();
  });

  app.post("/workspaces/current/owner-transfer", async (request) => {
    const session = await requirePermission(request, "members.update");
    if (session.role !== "OWNER" && !session.isRoot) throw httpError(403, "Apenas o OWNER pode transferir propriedade");
    const body = transferOwnerBody.parse(request.body);
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const roles = await client.query<{ id: string; name: string }>(
        "SELECT id,name FROM workspace_roles WHERE workspace_id=$1 AND name IN ('OWNER','ADMIN') FOR UPDATE",
        [session.tenantId]
      );
      const ownerRole = roles.rows.find((role) => role.name === "OWNER");
      const adminRole = roles.rows.find((role) => role.name === "ADMIN");
      if (!ownerRole || !adminRole) throw httpError(500, "Funções padrão ausentes");
      const currentOwner = await client.query<{ id: string; user_id: string }>(
        "SELECT id,user_id FROM workspace_members WHERE workspace_id=$1 AND role_id=$2 AND status='active' FOR UPDATE",
        [session.tenantId, ownerRole.id]
      );
      if (currentOwner.rows.length !== 1) throw httpError(409, "Workspace sem proprietário único");
      const target = await client.query<{ id: string; role_id: string; user_id: string }>(
        "SELECT id,role_id,user_id FROM workspace_members WHERE workspace_id=$1 AND id=$2 AND status='active' FOR UPDATE",
        [session.tenantId, body.memberId]
      );
      if (!target.rows[0]) throw httpError(404, "Novo OWNER não encontrado");
      if (target.rows[0].id === currentOwner.rows[0].id) throw httpError(409, "Membro já é OWNER");
      await client.query("UPDATE workspace_members SET role_id=$3,updated_at=now() WHERE workspace_id=$1 AND id=$2", [session.tenantId, currentOwner.rows[0].id, adminRole.id]);
      await client.query("UPDATE workspace_members SET role_id=$3,updated_at=now() WHERE workspace_id=$1 AND id=$2", [session.tenantId, target.rows[0].id, ownerRole.id]);
      await client.query(
        "UPDATE users SET session_version=session_version+1,updated_at=now() WHERE id=ANY($1::uuid[])",
        [[currentOwner.rows[0].user_id, target.rows[0].user_id]]
      );
      await client.query(
        `INSERT INTO audit_logs(actor_user_id,workspace_id,actor_scope,action,resource_type,resource_id,metadata,ip_address,user_agent)
         VALUES($1,$2,$3,'members.owner.transfer','workspace_member',$4,$5,$6,$7)`,
        [
          session.userId,
          session.tenantId,
          session.actorScope,
          target.rows[0].id,
          { previousOwnerMemberId: currentOwner.rows[0].id },
          request.ip,
          typeof request.headers["user-agent"] === "string" ? request.headers["user-agent"] : null
        ]
      );
      await client.query("COMMIT");
      return { ownerMemberId: target.rows[0].id, previousOwnerMemberId: currentOwner.rows[0].id };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });

  app.get("/workspaces/current/roles", async (request) => {
    const session = await requireRootWorkspace(request);
    const [roles, permissions] = await Promise.all([
      db.query(
        `SELECT r.id,r.name,r.description,r.is_owner_role,r.is_system,r.created_at,r.updated_at,
                COALESCE(array_agg(rp.permission_key ORDER BY rp.permission_key) FILTER (WHERE rp.permission_key IS NOT NULL),'{}') permissions,
                count(m.id)::int member_count
         FROM workspace_roles r
         LEFT JOIN workspace_role_permissions rp ON rp.role_id=r.id
         LEFT JOIN workspace_members m ON m.role_id=r.id
         WHERE r.workspace_id=$1
         GROUP BY r.id
         ORDER BY r.is_owner_role DESC,r.is_system DESC,r.name`,
        [session.tenantId]
      ),
      db.query("SELECT key,module,action,description FROM permissions ORDER BY module,action,key")
    ]);
    return { roles: roles.rows, permissions: permissions.rows };
  });

  app.get("/workspaces/current/member-roles", async (request) => {
    const session = await requirePermission(request, "members.read");
    const result = await db.query<{
      id: string;
      name: string;
      description: string;
      is_owner_role: boolean;
      is_system: boolean;
      permissions: string[];
      member_count: number;
    }>(
      `SELECT r.id,r.name,r.description,r.is_owner_role,r.is_system,
              COALESCE(array_agg(rp.permission_key ORDER BY rp.permission_key)
                FILTER (WHERE rp.permission_key IS NOT NULL),'{}') permissions,
              count(DISTINCT m.id)::int member_count
       FROM workspace_roles r
       LEFT JOIN workspace_role_permissions rp ON rp.role_id=r.id
       LEFT JOIN workspace_members m ON m.role_id=r.id
       WHERE r.workspace_id=$1
       GROUP BY r.id
       ORDER BY r.is_system DESC,r.name`,
      [session.tenantId]
    );
    const granted = new Set(session.permissions);
    const roles = result.rows.filter((role) => {
      if (role.is_owner_role) return false;
      if (session.isRoot && session.rootWorkspaceAccess) return true;
      if (role.name === "ADMIN" && session.role !== "OWNER") return false;
      return role.permissions.every((permission) => granted.has(permission as PermissionKey));
    });
    return { roles };
  });

  app.post("/workspaces/current/roles", async (request, reply) => {
    const session = await requireRootWorkspace(request);
    const body = roleBody.parse(request.body);
    assertPermissionsGrantable(session, body.permissions);
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const role = await client.query<{ id: string }>(
        `INSERT INTO workspace_roles(workspace_id,name,description,is_owner_role,is_system)
         VALUES($1,$2,$3,false,false) RETURNING id`,
        [session.tenantId, body.name, body.description]
      );
      if (body.permissions.length > 0) {
        await client.query(
          `INSERT INTO workspace_role_permissions(role_id,permission_key)
           SELECT $1,key FROM permissions WHERE key=ANY($2::text[])`,
          [role.rows[0].id, body.permissions]
        );
        const count = await client.query<{ count: number }>("SELECT count(*)::int count FROM workspace_role_permissions WHERE role_id=$1", [role.rows[0].id]);
        if (count.rows[0].count !== new Set(body.permissions).size) throw httpError(400, "Permissão inválida");
      }
      await client.query("COMMIT");
      await audit(request, { action: "roles.create", resourceType: "workspace_role", resourceId: role.rows[0].id, metadata: { name: body.name } });
      return reply.status(201).send({ role: { id: role.rows[0].id } });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });

  app.put("/workspaces/current/roles/:roleId", async (request) => {
    const session = await requireRootWorkspace(request);
    const { roleId } = roleParams.parse(request.params);
    const body = roleBody.parse(request.body);
    if (await roleIsProtected(session.tenantId, roleId)) throw httpError(409, "Funções OWNER e de sistema são protegidas");
    assertPermissionsGrantable(session, body.permissions);
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const role = await client.query<{ id: string }>(
        "UPDATE workspace_roles SET name=$3,description=$4,updated_at=now() WHERE workspace_id=$1 AND id=$2 RETURNING id",
        [session.tenantId, roleId, body.name, body.description]
      );
      if (!role.rows[0]) throw httpError(404, "Função não encontrada");
      await client.query("DELETE FROM workspace_role_permissions WHERE role_id=$1", [roleId]);
      if (body.permissions.length > 0) {
        await client.query(
          `INSERT INTO workspace_role_permissions(role_id,permission_key)
           SELECT $1,key FROM permissions WHERE key=ANY($2::text[])`,
          [roleId, body.permissions]
        );
        const count = await client.query<{ count: number }>("SELECT count(*)::int count FROM workspace_role_permissions WHERE role_id=$1", [roleId]);
        if (count.rows[0].count !== new Set(body.permissions).size) throw httpError(400, "Permissão inválida");
      }
      await client.query("COMMIT");
      await audit(request, { action: "roles.update", resourceType: "workspace_role", resourceId: roleId, metadata: { name: body.name } });
      return { role: { id: roleId } };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });

  app.delete("/workspaces/current/roles/:roleId", async (request, reply) => {
    const session = await requireRootWorkspace(request);
    const { roleId } = roleParams.parse(request.params);
    if (await roleIsProtected(session.tenantId, roleId)) throw httpError(409, "Funções OWNER e de sistema são protegidas");
    const used = await db.query<{ count: number }>("SELECT count(*)::int count FROM workspace_members WHERE workspace_id=$1 AND role_id=$2", [session.tenantId, roleId]);
    if (used.rows[0].count > 0) throw httpError(409, "Função em uso não pode ser excluída");
    const deleted = await db.query("DELETE FROM workspace_roles WHERE workspace_id=$1 AND id=$2 RETURNING id", [session.tenantId, roleId]);
    if (!deleted.rows[0]) throw httpError(404, "Função não encontrada");
    await audit(request, { action: "roles.delete", resourceType: "workspace_role", resourceId: roleId });
    return reply.status(204).send();
  });

  app.get("/workspaces/current/invitations", async (request) => {
    const session = await requirePermission(request, "members.read");
    const result = await db.query(
      `SELECT i.id,i.email,i.status,i.expires_at,i.created_at,i.accepted_at,
              r.id role_id,r.name role_name,
              inviter.email invited_by_email, accepted.email accepted_by_email
       FROM workspace_invitations i
       JOIN workspace_roles r ON r.id=i.role_id
       JOIN users inviter ON inviter.id=i.invited_by_user_id
       LEFT JOIN users accepted ON accepted.id=i.accepted_by_user_id
       WHERE i.workspace_id=$1
       ORDER BY i.created_at DESC`,
      [session.tenantId]
    );
    return { invitations: result.rows };
  });

  app.post("/workspaces/current/invitations", { config: { rateLimit: HTTP_RATE_LIMITS.invitationWrite } }, async (request, reply) => {
    const session = await requirePermission(request, "members.invite");
    const body = inviteBody.parse(request.body);
    await assertRoleAssignable(session, body.roleId);
    const emailProvider = getEmailProvider();
    const token = createInvitationToken();
    const client = await db.connect();
    let inTransaction = false;
    try {
      await client.query("BEGIN");
      inTransaction = true;
      const role = await client.query<{ name: string; is_owner_role: boolean; workspace_name: string }>(
        `SELECT r.name,r.is_owner_role,t.name workspace_name
         FROM workspace_roles r
         JOIN tenants t ON t.id=r.workspace_id
         WHERE r.workspace_id=$1 AND r.id=$2`,
        [session.tenantId, body.roleId]
      );
      if (!role.rows[0]) throw httpError(404, "Função não encontrada");
      if (role.rows[0].is_owner_role) throw httpError(409, "OWNER inicial exige fluxo ROOT/transferencia");
      const existingMember = await client.query<{ id: string }>(
        `SELECT m.id
         FROM workspace_members m
         JOIN users u ON u.id=m.user_id
         WHERE m.workspace_id=$1 AND u.email=lower($2)
         LIMIT 1`,
        [session.tenantId, body.email]
      );
      if (existingMember.rows[0]) throw httpError(409, "Usuário já pertence a este workspace");
      await client.query(
        "UPDATE workspace_invitations SET status='revoked' WHERE workspace_id=$1 AND lower(email)=lower($2) AND status='pending'",
        [session.tenantId, body.email]
      );
      const invitation = await client.query<{ id: string; expires_at: string }>(
        `INSERT INTO workspace_invitations(workspace_id,email,role_id,token_hash,status,expires_at,invited_by_user_id)
         VALUES($1,lower($2),$3,$4,'pending',now() + interval '7 days',$5)
         RETURNING id,expires_at`,
        [session.tenantId, body.email, body.roleId, tokenHash(token), session.userId]
      );
      await client.query("COMMIT");
      inTransaction = false;
      let emailDelivery: { status: "sent" | "failed"; error?: string } = { status: "sent" };
      try {
        await sendWorkspaceInvitationEmail(emailProvider, {
          recipientEmail: body.email.toLocaleLowerCase("en-US"),
          workspaceName: role.rows[0].workspace_name,
          roleName: role.rows[0].name,
          invitedByEmail: session.email,
          acceptUrl: buildInvitationAcceptUrl(config, token),
          expiresAt: new Date(invitation.rows[0].expires_at)
        });
      } catch (error) {
        emailDelivery = { status: "failed", error: "Convite criado, mas o e-mail não foi enviado. Verifique o SMTP e reenvie ou copie o link se ele estiver disponível." };
        app.log.error({ err: error, invitationId: invitation.rows[0].id, workspaceId: session.tenantId }, "Convite criado, mas falhou ao enviar e-mail");
      }
      await audit(request, { action: "members.invite", resourceType: "workspace_invitation", resourceId: invitation.rows[0].id, metadata: { email: body.email, roleId: body.roleId } });
      return reply.status(201).send({
        invitation: {
          id: invitation.rows[0].id,
          email: body.email.toLocaleLowerCase("en-US"),
          roleId: body.roleId,
          expiresAt: invitation.rows[0].expires_at
        },
        token: shouldExposeInvitationToken(config, emailProvider) ? token : undefined,
        emailDelivery
      });
    } catch (error) {
      if (inTransaction) await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });

  app.delete("/workspaces/current/invitations/:invitationId", async (request, reply) => {
    const session = await requirePermission(request, "members.invite");
    const { invitationId } = invitationParams.parse(request.params);
    const result = await db.query(
      "UPDATE workspace_invitations SET status='revoked' WHERE workspace_id=$1 AND id=$2 AND status='pending' RETURNING id",
      [session.tenantId, invitationId]
    );
    if (!result.rows[0]) throw httpError(404, "Convite pendente não encontrado");
    await audit(request, { action: "members.invitation.revoke", resourceType: "workspace_invitation", resourceId: invitationId });
    return reply.status(204).send();
  });

  app.get("/invitations/:token", { config: { rateLimit: HTTP_RATE_LIMITS.invitationRead } }, async (request) => {
    const { token } = invitationTokenParams.parse(request.params);
    const result = await db.query(
      `SELECT i.email,
              CASE WHEN i.status='pending' AND i.expires_at <= now() THEN 'expired' ELSE i.status END status,
              i.expires_at,t.name workspace_name,r.name role_name,
              EXISTS(
                SELECT 1 FROM users u
                WHERE u.email=i.email AND u.password_hash IS NOT NULL
              ) "existingUser"
       FROM workspace_invitations i
       JOIN tenants t ON t.id=i.workspace_id
       JOIN workspace_roles r ON r.id=i.role_id
       WHERE i.token_hash=$1`,
      [tokenHash(token)]
    );
    if (!result.rows[0]) throw httpError(404, "Convite não encontrado");
    return { invitation: result.rows[0] };
  });

  app.post("/auth/accept-invitation", { config: { rateLimit: HTTP_RATE_LIMITS.authentication } }, async (request, reply) => {
    const body = acceptInvitationBody.parse(request.body);
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const invitation = await client.query<{ id: string; workspace_id: string; email: string; role_id: string; status: string; expires_at: string; workspace_status: string }>(
        `SELECT i.id,i.workspace_id,i.email,i.role_id,i.status,i.expires_at,t.status workspace_status
         FROM workspace_invitations i
         JOIN tenants t ON t.id=i.workspace_id
         WHERE i.token_hash=$1
         FOR UPDATE OF i`,
        [tokenHash(body.token)]
      );
      const invite = invitation.rows[0];
      if (!invite) throw httpError(404, "Convite não encontrado");
      if (invite.status !== "pending") throw httpError(409, "Convite não está pendente");
      if (invite.workspace_status === "suspended") throw httpError(403, "Workspace suspenso");
      if (new Date(invite.expires_at).getTime() <= Date.now()) {
        await client.query("UPDATE workspace_invitations SET status='expired' WHERE id=$1", [invite.id]);
        throw httpError(409, "Convite expirado");
      }

      const existing = await client.query<{ id: string; email: string; password_hash: string | null; is_root: boolean; status: string }>(
        "SELECT id,email,password_hash,is_root,status FROM users WHERE email=$1",
        [invite.email]
      );
      let user = existing.rows[0];
      if (user?.status === "disabled") throw httpError(403, "Usuário desativado");
      if (user?.status === "active" && user.password_hash) {
        if (!body.currentPassword) throw httpError(400, "Informe a senha atual da sua conta");
        if (!(await compare(body.currentPassword, user.password_hash))) throw httpError(401, "Senha atual inválida");
      } else if (user) {
        if (!body.newPassword) throw httpError(400, "Crie uma nova senha para a sua conta");
        await client.query("UPDATE users SET password_hash=$2,status='active',session_version=session_version+1,updated_at=now() WHERE id=$1", [user.id, await hash(body.newPassword, 12)]);
      } else {
        if (!body.newPassword) throw httpError(400, "Crie uma nova senha para a sua conta");
        const created = await client.query<{ id: string; email: string; is_root: boolean }>(
          "INSERT INTO users(email,password_hash,status,is_root) VALUES($1,$2,'active',false) RETURNING id,email,is_root",
          [invite.email, await hash(body.newPassword, 12)]
        );
        user = { id: created.rows[0].id, email: created.rows[0].email, password_hash: null, is_root: created.rows[0].is_root, status: "active" };
      }
      const existingMember = await client.query<{ id: string }>(
        "SELECT id FROM workspace_members WHERE workspace_id=$1 AND user_id=$2",
        [invite.workspace_id, user.id]
      );
      if (existingMember.rows[0]) throw httpError(409, "Usuário já pertence a este workspace");
      await client.query(
        "INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at) VALUES($1,$2,$3,'active',now())",
        [invite.workspace_id, user.id, invite.role_id]
      );
      await client.query("UPDATE users SET session_version=session_version+1,updated_at=now() WHERE id=$1", [user.id]);
      await client.query(
        "UPDATE workspace_invitations SET status='accepted',accepted_by_user_id=$2,accepted_at=now() WHERE id=$1",
        [invite.id, user.id]
      );
      await client.query(
        `INSERT INTO audit_logs(actor_user_id,workspace_id,actor_scope,action,resource_type,resource_id,metadata,ip_address,user_agent)
         VALUES($1,$2,'workspace','members.invitation.accept','workspace_invitation',$3,$4,$5,$6)`,
        [
          user.id,
          invite.workspace_id,
          invite.id,
          { email: invite.email },
          request.ip,
          typeof request.headers["user-agent"] === "string" ? request.headers["user-agent"] : null
        ]
      );
      await client.query("COMMIT");
      const role = await db.query<{ name: string }>("SELECT name FROM workspace_roles WHERE id=$1", [invite.role_id]);
      const token = await createSessionToken({
        userId: user.id,
        tenantId: invite.workspace_id,
        email: user.email,
        role: role.rows[0].name,
        isRoot: user.is_root,
        rootWorkspaceAccess: user.is_root
      });
      reply.setCookie("atendon_session", token, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 43_200 });
      return { accepted: true, workspaceId: invite.workspace_id };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });

  app.get("/workspaces/current/audit-logs", async (request) => {
    const session = await requirePermission(request, "audit.read");
    const result = await db.query(
      `SELECT a.id,a.actor_scope,a.action,a.resource_type,a.resource_id,a.metadata,a.ip_address,a.user_agent,a.created_at,u.email actor_email
       FROM audit_logs a
       LEFT JOIN users u ON u.id=a.actor_user_id
       WHERE a.workspace_id=$1
       ORDER BY a.created_at DESC LIMIT 200`,
      [session.tenantId]
    );
    return { auditLogs: result.rows };
  });
}
