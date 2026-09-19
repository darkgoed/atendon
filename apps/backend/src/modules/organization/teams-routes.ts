import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requirePermission, requireWorkspace, type WorkspaceSession } from "../../auth/session.js";
import type { PermissionKey } from "../../auth/rbac.js";
import {
  createTeam,
  deleteTeam,
  listTeams,
  updateTeam,
  type TeamActor
} from "./teams.js";

const teamIdParams = z.object({ id: z.string().uuid() }).strict();
const teamCreateSchema = z.object({ name: z.string().trim().min(1).max(80) }).strict();
const teamUpdateSchema = z.object({ name: z.string().trim().min(1).max(80) }).strict();
const teamDeleteSchema = z.object({
  // Excluir com membros vinculados exige desassociação explícita (spec B6).
  detach_members: z.boolean().optional().default(false)
}).strict();

// Leitura da estrutura de equipes serve filtros e dropdowns de atribuição —
// qualquer membro ativo do workspace lê; gestão é members.update (key de
// membros REUSADA, spec B6 — nenhuma key nova).
const TEAM_READ_PERMISSIONS: PermissionKey[] = [
  "members.read",
  "conversations.read",
  "leads.read",
  "appointments.read"
];

function canReadTeams(session: WorkspaceSession): boolean {
  if (session.isRoot && session.rootWorkspaceAccess) return true;
  return TEAM_READ_PERMISSIONS.some((permission) => session.permissions.includes(permission));
}

function actor(session: WorkspaceSession, ip?: string, userAgent?: string): TeamActor & { userId: string } {
  return {
    userId: session.userId,
    actorScope: session.actorScope,
    ipAddress: ip,
    userAgent
  };
}

export async function registerTeamsRoutes(app: FastifyInstance) {
  app.get("/organization/teams", async (request) => {
    const session = await requireWorkspace(request);
    if (!canReadTeams(session)) {
      throw Object.assign(new Error("Permissão insuficiente"), { statusCode: 403 });
    }
    return { teams: await listTeams(session.tenantId) };
  });

  app.post("/organization/teams", async (request, reply) => {
    const session = await requirePermission(request, "members.update");
    const input = teamCreateSchema.parse(request.body);
    const team = await createTeam(session.tenantId, actor(session, request.ip, request.headers["user-agent"]), input);
    return reply.status(201).send({ team });
  });

  app.patch("/organization/teams/:id", async (request) => {
    const session = await requirePermission(request, "members.update");
    const { id } = teamIdParams.parse(request.params);
    const input = teamUpdateSchema.parse(request.body);
    return { team: await updateTeam(session.tenantId, id, actor(session, request.ip, request.headers["user-agent"]), input) };
  });

  app.delete("/organization/teams/:id", async (request) => {
    const session = await requirePermission(request, "members.update");
    const { id } = teamIdParams.parse(request.params);
    const input = teamDeleteSchema.parse(request.body ?? {});
    await deleteTeam(session.tenantId, id, actor(session, request.ip, request.headers["user-agent"]), input);
    return { ok: true };
  });
}
