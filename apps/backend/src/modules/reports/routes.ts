// ONDA 2-B (SPEC v7) — B1 rotas de relatórios.
// Todas as rotas exigem dashboard.read (capability EXISTENTE — nenhuma key
// nova) e escopo por sessão (resolveCaseScope): OWNER/ADMIN/SUPERVISOR/ROOT
// veem o workspace inteiro; operador vê o próprio escopo. Export CSV segue o
// padrão de /usage/export (app.ts:1164) — sem tocar no app.ts, o registro
// deste plugin é entregue como patch para o orquestrador.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { resolveCaseScope } from "../../auth/case-scope.js";
import { db } from "../../db/client.js";
import { requirePermission } from "../../auth/session.js";
import { HTTP_RATE_LIMITS } from "../../security/http-rate-limit.js";
import {
  buildReportCsv,
  loadAgentProductivity,
  loadConversationVolume,
  loadQualityReport,
  loadStatusFlow,
  loadTenantTimezone,
  resolveReportRange,
  type ReportCsvType
} from "./service.js";

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const reportQuery = z.object({
  from: dateSchema.optional(),
  to: dateSchema.optional()
}).strict();

const exportQuery = z.object({
  type: z.enum(["volume", "agents", "status", "quality"]),
  from: dateSchema.optional(),
  to: dateSchema.optional()
}).strict();

const CSV_FILENAMES: Record<ReportCsvType, string> = {
  volume: "volume-conversas",
  agents: "produtividade-agentes",
  status: "fluxo-status",
  quality: "qualidade"
};

export async function registerReportsRoutes(app: FastifyInstance) {
  app.get("/reports/conversation-volume", async (request) => {
    const session = await requirePermission(request, "dashboard.read");
    const query = reportQuery.parse(request.query ?? {});
    const timezone = await loadTenantTimezone(session.tenantId);
    const scope = await resolveCaseScope(db, session);
    const range = resolveReportRange(query.from, query.to, timezone);
    return await loadConversationVolume(session.tenantId, scope, range, timezone);
  });

  app.get("/reports/agent-productivity", async (request) => {
    const session = await requirePermission(request, "dashboard.read");
    const query = reportQuery.parse(request.query ?? {});
    const scope = await resolveCaseScope(db, session);
    const range = resolveReportRange(query.from, query.to, await loadTenantTimezone(session.tenantId));
    return await loadAgentProductivity(session.tenantId, scope, range);
  });

  app.get("/reports/status-flow", async (request) => {
    const session = await requirePermission(request, "dashboard.read");
    const query = reportQuery.parse(request.query ?? {});
    const scope = await resolveCaseScope(db, session);
    const range = resolveReportRange(query.from, query.to, await loadTenantTimezone(session.tenantId));
    return await loadStatusFlow(session.tenantId, scope, range);
  });

  app.get("/reports/quality", async (request) => {
    const session = await requirePermission(request, "dashboard.read");
    const query = reportQuery.parse(request.query ?? {});
    const scope = await resolveCaseScope(db, session);
    const range = resolveReportRange(query.from, query.to, await loadTenantTimezone(session.tenantId));
    return await loadQualityReport(session.tenantId, scope, range);
  });

  app.get("/reports/export/csv", { config: { rateLimit: HTTP_RATE_LIMITS.export } }, async (request, reply) => {
    const session = await requirePermission(request, "dashboard.read");
    const query = exportQuery.parse(request.query ?? {});
    const scope = await resolveCaseScope(db, session);
    const range = resolveReportRange(query.from, query.to, await loadTenantTimezone(session.tenantId));
    const stream = await buildReportCsv(session.tenantId, scope, query.type, range);
    return reply
      .type("text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="${CSV_FILENAMES[query.type]}-${range.from}_a_${range.to}.csv"`)
      .send(stream);
  });
}
