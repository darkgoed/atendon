// Rotas do módulo internal: central de notificações internas por usuário (R2)
// e notas internas com @menções (R3). Plugin registrado pelo orquestrador em
// app.ts (ver patch entregue no relatório do worker).
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { db } from "../../db/client.js";
import { requirePermission, requireSession, type WorkspaceSession } from "../../auth/session.js";
import { canAccessConversation, leadScopeCondition, resolveCaseScope, type CaseScope } from "../../auth/case-scope.js";
import {
  createConversationNote,
  createLeadNote,
  internalNoteBodySchema,
  internalNotificationsQuerySchema,
  listConversationNotes,
  listInternalNotifications,
  listLeadNotes,
  markAllInternalNotificationsRead,
  markInternalNotificationRead
} from "./service.js";

const idParams = z.object({ id: z.string().uuid() });

// Espelhos de scheduling/routes.ts (helpers privados lá): o escopo de caso
// decide se o usuário vê leads da empresa inteira (gestor) ou apenas os seus.
// Read aceita também sdr/closer/recovery, igual ao acompanhamento de leads.
function leadReadScopeCondition(scope: CaseScope, alias: string, memberParameter: string): string {
  if (scope.type === "workspace") return `(${memberParameter}::uuid IS NULL OR ${memberParameter}::uuid IS NOT NULL)`;
  if (!scope.memberId) return "FALSE";
  return `(${alias}.assigned_member_id=${memberParameter} OR ${alias}.sdr_member_id=${memberParameter} OR ${alias}.closer_member_id=${memberParameter} OR ${alias}.recovery_member_id=${memberParameter})`;
}

async function canReadLead(session: WorkspaceSession, scope: CaseScope, leadId: string): Promise<boolean> {
  const result = await db.query(
    `SELECT 1 FROM scheduling_leads lead
     WHERE lead.tenant_id=$1 AND lead.id=$2 AND lead.deleted_at IS NULL
       AND (${leadReadScopeCondition(scope, "lead", "$3")})`,
    [session.tenantId, leadId, scope.memberId]
  );
  return Boolean(result.rows[0]);
}

async function canAccessLead(session: WorkspaceSession, scope: CaseScope, leadId: string): Promise<boolean> {
  const result = await db.query(
    `SELECT 1 FROM scheduling_leads lead
     WHERE lead.tenant_id=$1 AND lead.id=$2 AND lead.deleted_at IS NULL
       AND (${leadScopeCondition(scope, "lead", "$3")})`,
    [session.tenantId, leadId, scope.memberId]
  );
  return Boolean(result.rows[0]);
}

export async function registerInternalRoutes(app: FastifyInstance) {
  // Central de notificações internas: SEMPRE escopada ao user_id do token
  // (sem gate de gestão; alertas agregados de gestores seguem em /alerts).
  app.get("/me/internal-notifications", async (request) => {
    const session = await requireSession(request);
    const query = internalNotificationsQuerySchema.parse(request.query);
    return listInternalNotifications(session, query);
  });
  app.post("/me/internal-notifications/:id/read", async (request) => {
    const session = await requireSession(request);
    const { id } = idParams.parse(request.params);
    return markInternalNotificationRead(session, id);
  });
  app.post("/me/internal-notifications/read-all", async (request) => {
    const session = await requireSession(request);
    return markAllInternalNotificationsRead(session);
  });

  // Notas de lead — fonte unificada com a rota existente
  // POST /scheduling/leads/:id/notes (mesma tabela scheduling_lead_notes).
  // Permissões espelham o acompanhamento do lead: ler = leads.follow_up.read,
  // criar = leads.follow_up.manage.
  app.get("/leads/:id/notes", async (request, reply) => {
    const session = await requirePermission(request, "leads.follow_up.read");
    const { id } = idParams.parse(request.params);
    const scope = await resolveCaseScope(db, session);
    if (!await canReadLead(session, scope, id)) return reply.status(404).send({ error: "Lead não encontrado" });
    return listLeadNotes(session.tenantId, id);
  });
  app.post("/leads/:id/notes", async (request, reply) => {
    const session = await requirePermission(request, "leads.follow_up.manage");
    const { id } = idParams.parse(request.params);
    const scope = await resolveCaseScope(db, session);
    if (!await canAccessLead(session, scope, id)) return reply.status(404).send({ error: "Lead não encontrado" });
    const body = internalNoteBodySchema.parse(request.body);
    return reply.status(201).send(await createLeadNote(session.tenantId, id, followUpActorFrom(session, request), body));
  });

  // Notas de conversa — leitura espelha a permissão de ver a conversa
  // (conversations.read + escopo), criação para qualquer membro com
  // conversations.reply, sempre com o mesmo escopo de acesso da conversa.
  app.get("/conversations/:id/notes", async (request, reply) => {
    const session = await requirePermission(request, "conversations.read");
    const { id } = idParams.parse(request.params);
    if (!await canAccessConversation(db, session, id)) return reply.status(404).send({ error: "Conversa não encontrada" });
    return listConversationNotes(session.tenantId, id);
  });
  app.post("/conversations/:id/notes", async (request, reply) => {
    const session = await requirePermission(request, "conversations.reply");
    const { id } = idParams.parse(request.params);
    if (!await canAccessConversation(db, session, id)) return reply.status(404).send({ error: "Conversa não encontrada" });
    const body = internalNoteBodySchema.parse(request.body);
    return reply.status(201).send(await createConversationNote(session.tenantId, id, session, body));
  });
}

function followUpActorFrom(session: WorkspaceSession, request: FastifyRequest) {
  return {
    userId: session.userId,
    actorScope: session.actorScope,
    workspaceCaseAccess: session.isRoot === true || ["ROOT", "OWNER", "ADMIN", "SUPERVISOR"].includes(session.role.trim().toUpperCase()),
    ipAddress: request.ip,
    userAgent: typeof request.headers["user-agent"] === "string" ? request.headers["user-agent"] : undefined
  };
}