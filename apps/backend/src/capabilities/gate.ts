import type { FastifyRequest } from "fastify";
import { requireWorkspace } from "../auth/session.js";
import { db } from "../db/client.js";
import {
  resolveCapability,
  type CapabilityKey
} from "../modules/operations/feature-flags.js";

type ApiCapabilityGate = { capability: CapabilityKey; };

const API_CAPABILITY_GATES = new Map<string, ApiCapabilityGate>([
  ["POST /leads", { capability: "leads_v1" }],
  ["GET /categorias", { capability: "leads_v1" }],
  ["GET /parceiros", { capability: "leads_v1" }],
  ["POST /leads/:id/proposta-parceiro", { capability: "leads_v1" }],
  ["PATCH /leads/:id/status", { capability: "leads_v1" }],
  ["POST /leads/:id/transferir", { capability: "leads_v1" }],
  ["GET /unidades/:unidade_id/horarios", { capability: "appointments_v1" }],
  ["POST /agendamentos", { capability: "appointments_v1" }],
  ["PATCH /agendamentos/:id/reagendar", { capability: "appointments_v1" }],
  ["DELETE /agendamentos/:id", { capability: "appointments_v1" }]
]);

function panelCapability(path: string, method: string): CapabilityKey | undefined {
  if (path === "/dashboard" || path.startsWith("/dashboard/widgets")) return "dashboard_v1";
  if (path.startsWith("/qualification/")) return "leads_v1";
  if (path.startsWith("/organization/pipeline") || path.startsWith("/organization/bulk")
    || path === "/organization/leads/:leadId/stage") return "pipeline_v1";
  if (path.startsWith("/organization/saved-views")) return undefined;
  if (path.startsWith("/organization/")) return "leads_v1";

  if (path.startsWith("/scheduling/appointments")
    || path.startsWith("/scheduling/appointment-")
    || path === "/scheduling/availability"
    || path === "/scheduling/conversations/:id/appointment-context"
    || path.startsWith("/scheduling/config/notifications")
    || path.startsWith("/scheduling/config/notification-groups")
    || path.startsWith("/scheduling/config/attendants")
    || path.startsWith("/scheduling/attendants/")) return "appointments_v1";

  // Configuration reads are HTTP surfaces for human administrators. Internal
  // service calls made by enabled modules do not pass through this boundary.
  if (path.startsWith("/scheduling/config/")) return "workspace_admin_v1";
  if (path.startsWith("/scheduling/leads")) return "leads_v1";

  if (path === "/connection" || path.startsWith("/connection/")
    || path === "/connections" || path.startsWith("/connections/")
    || path === "/agent" || path.startsWith("/agent/")
    || path === "/usage" || path.startsWith("/usage/")
    || path === "/humanizer" || path.startsWith("/humanizer/")
    || path === "/signature"
    || path.startsWith("/ai-follow-ups/")
    || path === "/ai-stickers" || path.startsWith("/ai-stickers/")) return "workspace_admin_v1";

  if (path.startsWith("/workspaces/current/invitations")) return undefined;
  if (path.startsWith("/workspaces/current/members")
    || path.startsWith("/workspaces/current/roles")
    || path.startsWith("/workspaces/current/member-roles")
    || path.startsWith("/workspaces/current/owner-transfer")
    || path.startsWith("/workspaces/current/audit-logs")) return "workspace_admin_v1";
  if (path === "/workspaces/current/timezone" && method !== "GET") return "workspace_admin_v1";
  if (path === "/workspaces/current" && method !== "GET") return "workspace_admin_v1";
  return undefined;
}

function disabledCapability(key: CapabilityKey) {
  return Object.assign(new Error("Funcionalidade indisponível para esta empresa"), {
    statusCode: 409,
    code: "FEATURE_FLAG_DISABLED",
    feature: key
  });
}

export async function assertCapability(tenantId: string, key: CapabilityKey): Promise<void> {
  const decision = await resolveCapability(db, tenantId, key);
  if (!decision.enabled) throw disabledCapability(key);
}

/**
 * Authenticates first, resolves the active tenant, then evaluates the module.
 * The route handler still performs its normal permission/scope check; a
 * capability is an additional denial boundary and never grants permission.
 */
export async function enforceRequestCapability(request: FastifyRequest): Promise<void> {
  const path = request.routeOptions.url;
  if (!path) return;
  const apiGate = API_CAPABILITY_GATES.get(`${request.method} ${path}`);
  if (apiGate) {
    const session = await requireWorkspace(request);
    await assertCapability(session.tenantId, apiGate.capability);
    return;
  }
  const capability = panelCapability(path, request.method);
  if (!capability) return;
  const session = await requireWorkspace(request);
  await assertCapability(session.tenantId, capability);
}

export const capabilityForPanelRoute = panelCapability;
