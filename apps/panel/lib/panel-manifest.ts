import {
  CalendarDots,
  Clock,
  ChatsCircle,
  ClipboardText,
  Gauge,
  GearSix,
  HandHeart,
  Kanban,
  Sparkle,
  UsersThree,
  Vault,
  Watch,
  CreditCard
} from "@phosphor-icons/react";
import type { PanelSession } from "./session";
import { canAccessRootWorkspace, canAccessWithSession } from "./session";

export const capabilityKeys = [
  "dashboard_v1",
  "leads_v1",
  "pipeline_v1",
  "appointments_v1",
  "post_sales_v1",
  "tripz_ai_v1",
  "workspace_admin_v1"
] as const;

export type CapabilityKey = (typeof capabilityKeys)[number];
export type PlanFeatureKey = "AI_FOLLOWUP";

export type PanelManifestItem = {
  href: string;
  label: string;
  group: "Atendimento" | "Pós-venda" | "Copiloto" | "Administração" | "ROOT";
  Icon: typeof Gauge;
  requiredPermissions?: readonly string[];
  capability?: CapabilityKey;
  requiredFeature?: PlanFeatureKey;
  rootOnly?: boolean;
  rootWorkspaceOnly?: boolean;
  menu?: boolean;
  match?: (path: string) => boolean;
};

const administrationPaths = [
  "/configuracoes",
  "/conexao",
  "/workspace/members",
  "/workspace/roles",
  "/workspace/audit",
  "/agente",
  "/humanizacao"
] as const;

const startsAt = (base: string) => (path: string) => path === base || path.startsWith(`${base}/`);

/**
 * Fonte única para descoberta de rota, menu, paleta, permissão e capability.
 * Rotas de autenticação, convites, perfil, senha e ROOT são deliberadamente
 * ausentes de `capability` e nunca são bloqueadas pelo catálogo comercial.
 */
export const panelManifest: readonly PanelManifestItem[] = [
  { href: "/", label: "Visão geral", group: "Atendimento", Icon: Gauge, requiredPermissions: ["dashboard.read"], capability: "dashboard_v1", menu: true, match: (path) => path === "/" },
  { href: "/conversas", label: "Conversas", group: "Atendimento", Icon: ChatsCircle, requiredPermissions: ["conversations.read"], menu: true, match: startsAt("/conversas") },
  { href: "/pipeline", label: "Pipeline", group: "Atendimento", Icon: Kanban, requiredPermissions: ["leads.read"], capability: "pipeline_v1", menu: true, match: startsAt("/pipeline") },
  { href: "/leads", label: "Leads", group: "Atendimento", Icon: UsersThree, requiredPermissions: ["leads.read"], capability: "leads_v1", menu: true, match: startsAt("/leads") },
  { href: "/agenda", label: "Agenda", group: "Atendimento", Icon: CalendarDots, requiredPermissions: ["appointments.read"], capability: "appointments_v1", menu: true, match: startsAt("/agenda") },
  { href: "/pos-venda", label: "Carteira", group: "Pós-venda", Icon: HandHeart, requiredPermissions: ["post_sales.use"], capability: "post_sales_v1", menu: true, match: (path) => path === "/pos-venda" || path.startsWith("/pos-venda/cobranca") },
  { href: "/pos-venda/configurar", label: "Configurar checklist", group: "Pós-venda", Icon: ClipboardText, requiredPermissions: ["post_sales.manage"], capability: "post_sales_v1", menu: true, match: startsAt("/pos-venda/configurar") },
  { href: "/tripz-ai", label: "Tripz IA", group: "Copiloto", Icon: Sparkle, requiredPermissions: ["tripz_ai.use"], capability: "tripz_ai_v1", menu: true, match: startsAt("/tripz-ai") },
  { href: "/alertas", label: "Alertas", group: "Administração", Icon: Watch, capability: "workspace_admin_v1", rootOnly: true, match: startsAt("/alertas") },
  { href: "/follow-ups", label: "Follow-ups", group: "Administração", Icon: Clock, rootWorkspaceOnly: true, requiredFeature: "AI_FOLLOWUP", menu: true, match: startsAt("/follow-ups") },
  // Cobrança nunca pode depender de uma capability comercial: uma empresa
  // suspensa precisa alcançar esta rota justamente para quitar e reativar.
  { href: "/uso", label: "Uso e cobrança", group: "Administração", Icon: CreditCard, requiredPermissions: ["usage.read"], menu: true, match: startsAt("/uso") },
  { href: "/configuracoes", label: "Configurações", group: "Administração", Icon: GearSix, capability: "workspace_admin_v1", menu: true, match: (path) => administrationPaths.some((base) => startsAt(base)(path)) },
  { href: "/root/workspaces", label: "Empresas", group: "ROOT", Icon: Vault, rootOnly: true, menu: true, match: startsAt("/root/workspaces") },
  { href: "/root/versions", label: "Versões e changelogs", group: "ROOT", Icon: Sparkle, rootOnly: true, menu: true, match: startsAt("/root/versions") },
  { href: "/root/saas/planos", label: "Planos e cobrança", group: "ROOT", Icon: CreditCard, rootOnly: true, menu: true, match: startsAt("/root/saas/planos") },
  { href: "/root/saas/gateways", label: "Gateways", group: "ROOT", Icon: CreditCard, rootOnly: true, menu: true, match: startsAt("/root/saas/gateways") },
  { href: "/root/saas/metricas", label: "Métricas SaaS", group: "ROOT", Icon: Gauge, rootOnly: true, menu: true, match: startsAt("/root/saas/metricas") },
  { href: "/root/audit", label: "Auditoria ROOT", group: "ROOT", Icon: Watch, rootOnly: true, menu: true, match: startsAt("/root/audit") },
  { href: "/changelog", label: "Changelog", group: "Administração", Icon: Sparkle, menu: false, match: startsAt("/changelog") },
  { href: "/perfil", label: "Perfil", group: "Administração", Icon: GearSix, match: startsAt("/perfil") },
  { href: "/alterar-senha", label: "Alterar senha", group: "Administração", Icon: GearSix, match: startsAt("/alterar-senha") }
] as const;

export const panelManifestGroups = ["Atendimento", "Pós-venda", "Copiloto", "Administração", "ROOT"] as const;

export function findPanelManifestItem(path: string): PanelManifestItem | undefined {
  return panelManifest.find((item) => item.match?.(path));
}

export function canAccessManifestItem(session: PanelSession, item: PanelManifestItem): boolean {
  if (item.rootWorkspaceOnly) return canAccessRootWorkspace(session);
  if (item.rootOnly) return session.user.isRoot;
  return canAccessWithSession(session, item.requiredPermissions);
}

export function canExposeManifestItem(
  session: PanelSession,
  item: PanelManifestItem,
  capabilityEnabled: (capability: CapabilityKey) => boolean,
  featureEnabled: (feature: PlanFeatureKey) => boolean
): boolean {
  return canAccessManifestItem(session, item)
    && (!item.capability || capabilityEnabled(item.capability))
    && (!item.requiredFeature || featureEnabled(item.requiredFeature));
}

export function firstEnabledModulePath(
  session: PanelSession,
  enabled: (capability: CapabilityKey) => boolean
): string {
  return panelManifest.find((item) =>
    item.menu
    && item.group !== "ROOT"
    && canAccessManifestItem(session, item)
    && (!item.capability || enabled(item.capability)))?.href ?? "/conversas";
}
