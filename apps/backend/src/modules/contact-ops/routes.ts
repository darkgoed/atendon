// W2B — rotas de contact-ops (R14/R15/R17/R20). Padrão de rota/perm/audit
// segue src/modules/organization/routes.ts; todo endpoint tem requirePermission
// ou requireWorkspace (R27).
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { requirePermission, requireWorkspace } from "../../auth/session.js";
import { resolveCaseScope } from "../../auth/case-scope.js";
import { db } from "../../db/client.js";
import { HTTP_RATE_LIMITS } from "../../security/http-rate-limit.js";
import { importContacts, exportLeadsCsv, listAwaitingReply, onboardingStatus, type ExportQuery } from "./service.js";

const columnRef = z.string().trim().min(1).max(200);
const importBody = z.object({
  csv_base64: z.string().min(1).optional(),
  xlsx_base64: z.string().min(1).optional(),
  filename: columnRef,
  mapping: z.object({
    nome: columnRef.optional(),
    telefone: columnRef.optional(),
    email: columnRef.optional(),
    tags: columnRef.optional(),
    origem: columnRef.optional(),
    campanha: columnRef.optional(),
    custom: z.record(z.string().trim().min(1).max(100), columnRef).optional()
  }).strict(),
  options: z.object({
    on_duplicate: z.enum(["skip", "update", "flag"]).default("skip")
  }).strict().default({})
}).strict();

const leadStatusValues = ["em_qualificacao", "aguardando_proposta", "aprovado", "recusado", "agendado", "cancelado", "transferido"] as const;
const appointmentStatusValues = ["confirmado", "reagendado", "cancelado", "concluido", "no_show"] as const;
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
// Mesmos filtros aceitos por GET /scheduling/leads, sem limit/cursor.
const exportQuery = z.object({
  ids: z.string().optional(),
  status: z.enum(leadStatusValues).optional(),
  unidade_id: z.string().trim().min(1).max(120).optional(),
  categoria_id: z.string().trim().min(1).max(120).optional(),
  parceiro_id: z.string().trim().min(1).max(120).optional(),
  busca: z.string().trim().max(200).optional(),
  estrelas: z.coerce.number().int().min(1).max(5).optional(),
  pipeline_stage_id: z.string().uuid().optional(),
  sdr_member_id: z.string().uuid().optional(),
  closer_member_id: z.string().uuid().optional(),
  origem: z.string().trim().max(200).optional(),
  campanha: z.string().trim().max(200).optional(),
  period_start: dateSchema.optional(),
  period_end: dateSchema.optional(),
  appointment_status: z.enum(appointmentStatusValues).optional(),
  commercial_outcome: z.enum(["fechado", "proposta_enviada", "em_negociacao", "follow_up", "nao_avancou"]).optional(),
  action_bucket: z.enum(["result_pending", "recovery", "overdue_follow_up", "today"]).optional(),
  fila_humana: z.enum(["true"]).optional(),
  faturamento: z.string().trim().min(1).max(200).optional(),
  resultado: z.string().trim().min(1).max(200).optional(),
  investimento: z.string().trim().min(1).max(200).optional(),
  formulario: z.string().trim().min(1).max(200).optional()
}).partial().strict();

const awaitingReplyQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().trim().min(1).max(512).optional()
});

function actor(request: FastifyRequest, session: { userId: string; actorScope: "root" | "workspace" }) {
  return {
    userId: session.userId,
    actorScope: session.actorScope,
    ipAddress: request.ip,
    userAgent: typeof request.headers["user-agent"] === "string" ? request.headers["user-agent"] : undefined
  };
}

export async function registerContactOpsRoutes(app: FastifyInstance) {
  app.post("/contact-ops/import", {
    bodyLimit: 30 * 1024 * 1024,
    config: { rateLimit: HTTP_RATE_LIMITS.upload }
  }, async (request) => {
    const session = await requirePermission(request, "leads.create");
    const body = importBody.parse(request.body);
    return importContacts(session.tenantId, actor(request, session), body);
  });

  app.get("/contact-ops/export.csv", { config: { rateLimit: HTTP_RATE_LIMITS.export } }, async (request, reply) => {
    const session = await requirePermission(request, "leads.follow_up.read");
    const scope = await resolveCaseScope(db, session);
    const raw = exportQuery.parse(request.query);
    const filters: ExportQuery = {
      ...raw,
      ids: raw.ids ? raw.ids.split(",").map((id) => id.trim()).filter(Boolean) : undefined,
      fila_humana: raw.fila_humana === "true"
    };
    const { stream, truncated } = await exportLeadsCsv(session.tenantId, scope, filters);
    return reply
      .type("text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="contatos-${new Date().toISOString().slice(0, 10)}.csv"`)
      .header("x-export-truncated", truncated ? "true" : "false")
      .send(stream);
  });

  app.get("/contact-ops/awaiting-reply", async (request) => {
    const session = await requirePermission(request, "conversations.read");
    const scope = await resolveCaseScope(db, session);
    return listAwaitingReply(session.tenantId, scope, awaitingReplyQuery.parse(request.query));
  });

  app.get("/organization/onboarding-status", async (request) => {
    const session = await requireWorkspace(request);
    return onboardingStatus(session.tenantId);
  });
}
