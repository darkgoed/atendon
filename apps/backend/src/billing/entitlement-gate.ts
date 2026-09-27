import type { FastifyRequest } from "fastify";
import { requireWorkspace } from "../auth/session.js";
import { assertFeature } from "./entitlements.js";

type FeatureKey = "CALENDAR" | "AI" | "AI_FOLLOWUP" | "PIPELINE" | "POST_SALES" | "MEET" | "BULK_OPERATIONS";

const EXEMPT_PREFIXES = [
  "/root", "/auth", "/health", "/ready", "/me", "/workspaces/current", "/events",
  "/webhooks", "/billing/my-plan",
  // Link público de convidado da reunião: sem sessão; o anfitrião já tem o plano.
  "/meet/join"
];

// Fronteira de segmento: "/meet/rooms".startsWith("/me") isentava o gate MEET
// inteiro (e qualquer rota futura começando com "/me…").
function isExempt(path: string): boolean {
  return EXEMPT_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

const API_FEATURE_GATES = new Map<string, FeatureKey>([
  ["POST /agendamentos", "CALENDAR"],
  ["PATCH /agendamentos/:id/reagendar", "CALENDAR"],
  ["DELETE /agendamentos/:id", "CALENDAR"],
  ["GET /unidades/:unidade_id/horarios", "CALENDAR"]
]);

function featureForRoute(path: string, method: string): FeatureKey | undefined {
  const exact = API_FEATURE_GATES.get(`${method} ${path}`);
  if (exact) return exact;
  if (path.startsWith("/scheduling/appointments")
    || path.startsWith("/scheduling/appointment-")
    || path === "/scheduling/availability") return "CALENDAR";
  if (path === "/agent" || path.startsWith("/agent/")
    || path.startsWith("/humanizer") || path.startsWith("/ai-stickers")) return "AI";
  if (path.startsWith("/ai-follow-ups/")) return "AI_FOLLOWUP";
  if (path.startsWith("/organization/pipeline") || path === "/organization/leads/:leadId/stage") return "PIPELINE";
  if (path.startsWith("/post-sales/")) return "POST_SALES";
  if (path.startsWith("/meet/")) return "MEET";
  if (path.startsWith("/organization/bulk")) return "BULK_OPERATIONS";
  return undefined;
}

export async function enforceRequestEntitlement(request: FastifyRequest): Promise<void> {
  const path = request.routeOptions.url;
  if (!path || isExempt(path)) return;
  const feature = featureForRoute(path, request.method);
  if (!feature) return;
  const session = await requireWorkspace(request);
  await assertFeature(session.tenantId, feature);
}
