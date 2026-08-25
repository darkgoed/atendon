import type { PermissionKey } from "../../auth/rbac.js";

export const DASHBOARD_WIDGET_KEYS = [
  "commercial_metrics",
  "conversion_funnel",
  "operations_summary",
  "whatsapp_connection",
  "handoffs",
  "open_conversations",
  "messages_today",
  "today_agenda",
  "team_load",
  "pipeline",
  "recent_alerts"
] as const;

export type DashboardWidgetKey = typeof DASHBOARD_WIDGET_KEYS[number];
export const DASHBOARD_WIDGET_SIZES = ["small", "medium", "wide", "full"] as const;
export type DashboardWidgetSize = typeof DASHBOARD_WIDGET_SIZES[number];

export interface DashboardWidgetDefinition {
  key: DashboardWidgetKey;
  label: string;
  description: string;
  requiredPermissions: PermissionKey[];
  sizes: DashboardWidgetSize[];
  defaultSize: DashboardWidgetSize;
  defaultVisible: boolean;
}

export interface DashboardLayoutItem {
  key: DashboardWidgetKey;
  order: number;
  visible: boolean;
  size: DashboardWidgetSize;
}

// A ordem do catálogo é a hierarquia padrão da Visão Geral:
// 1º resultado, 2º conversão, 3º performance, 4º operação.
export const DASHBOARD_WIDGET_CATALOG: DashboardWidgetDefinition[] = [
  { key: "commercial_metrics", label: "Resultado comercial", description: "Contatos, agendamentos, calls, no-show e vendas do período.", requiredPermissions: ["leads.read", "appointments.read"], sizes: ["wide", "full"], defaultSize: "full", defaultVisible: true },
  { key: "conversion_funnel", label: "Funil de conversão", description: "Lead → agendamento → call → venda e as taxas entre as etapas.", requiredPermissions: ["leads.read", "appointments.read"], sizes: ["medium", "wide", "full"], defaultSize: "full", defaultVisible: true },
  { key: "team_load", label: "Performance por closer", description: "Calls, no-shows, vendas e valor vendido por closer no período.", requiredPermissions: ["availability.read", "appointments.read"], sizes: ["medium", "wide", "full"], defaultSize: "full", defaultVisible: true },
  { key: "today_agenda", label: "Agenda do dia", description: "Próximos compromissos acessíveis ao usuário.", requiredPermissions: ["appointments.read"], sizes: ["medium", "wide", "full"], defaultSize: "wide", defaultVisible: true },
  { key: "handoffs", label: "Handoffs na fila", description: "Conversas aguardando atendimento humano agora.", requiredPermissions: ["conversations.read"], sizes: ["small", "medium", "wide"], defaultSize: "medium", defaultVisible: true },
  { key: "operations_summary", label: "Operação", description: "Mensagens, conversas, handoffs, resposta e pendências do período.", requiredPermissions: ["leads.read", "conversations.read"], sizes: ["wide", "full"], defaultSize: "full", defaultVisible: true },
  { key: "whatsapp_connection", label: "Conexão WhatsApp", description: "Estado atual da conexão principal.", requiredPermissions: ["connection.read"], sizes: ["small", "medium"], defaultSize: "small", defaultVisible: true },
  { key: "open_conversations", label: "Conversas abertas", description: "Conversas em andamento e resolvidas hoje.", requiredPermissions: ["conversations.read"], sizes: ["small", "medium"], defaultSize: "small", defaultVisible: false },
  { key: "messages_today", label: "Mensagens hoje", description: "Volume de mensagens no dia.", requiredPermissions: ["conversations.read"], sizes: ["small", "medium"], defaultSize: "small", defaultVisible: false },
  { key: "pipeline", label: "Pipeline", description: "Distribuição dos leads por situação.", requiredPermissions: ["leads.read"], sizes: ["medium", "wide", "full"], defaultSize: "wide", defaultVisible: false },
  { key: "recent_alerts", label: "Alertas recentes", description: "Sinais operacionais mais recentes.", requiredPermissions: ["dashboard.read"], sizes: ["small", "medium", "wide"], defaultSize: "medium", defaultVisible: false }
];

export function availableDashboardWidgets(granted: readonly PermissionKey[]) {
  return DASHBOARD_WIDGET_CATALOG.filter((widget) =>
    widget.requiredPermissions.every((permission) => granted.includes(permission))
  );
}

export function defaultDashboardLayout(catalog: readonly DashboardWidgetDefinition[]): DashboardLayoutItem[] {
  return catalog.map((widget, order) => ({
    key: widget.key,
    order,
    visible: widget.defaultVisible,
    size: widget.defaultSize
  }));
}

export function sanitizeDashboardLayout(
  input: readonly DashboardLayoutItem[],
  catalog: readonly DashboardWidgetDefinition[]
): DashboardLayoutItem[] {
  const available = new Map(catalog.map((widget) => [widget.key, widget]));
  const seen = new Set<DashboardWidgetKey>();
  const items: DashboardLayoutItem[] = [];
  for (const candidate of [...input].sort((a, b) => a.order - b.order)) {
    const definition = available.get(candidate.key);
    if (!definition || seen.has(candidate.key)) continue;
    seen.add(candidate.key);
    items.push({
      key: candidate.key,
      order: items.length,
      visible: candidate.visible === true,
      size: definition.sizes.includes(candidate.size) ? candidate.size : definition.defaultSize
    });
  }
  // Widget novo (ainda não conhecido pelo layout salvo) entra com sua visibilidade padrão,
  // senão quem já personalizou nunca veria nada lançado depois.
  for (const definition of catalog) {
    if (seen.has(definition.key)) continue;
    items.push({
      key: definition.key,
      order: items.length,
      visible: definition.defaultVisible,
      size: definition.defaultSize
    });
  }
  return items;
}

export function validateDashboardLayout(
  input: readonly DashboardLayoutItem[],
  catalog: readonly DashboardWidgetDefinition[]
): DashboardLayoutItem[] {
  const known = new Set<string>(DASHBOARD_WIDGET_KEYS);
  const available = new Map(catalog.map((widget) => [widget.key, widget]));
  const seen = new Set<DashboardWidgetKey>();
  for (const item of input) {
    if (!known.has(item.key)) throw Object.assign(new Error("Widget desconhecido"), { statusCode: 400 });
    const definition = available.get(item.key);
    if (!definition) throw Object.assign(new Error("Widget não permitido"), { statusCode: 403 });
    if (seen.has(item.key)) throw Object.assign(new Error("Widget duplicado"), { statusCode: 400 });
    if (!definition.sizes.includes(item.size)) throw Object.assign(new Error("Tamanho indisponível para o widget"), { statusCode: 400 });
    seen.add(item.key);
  }
  return sanitizeDashboardLayout(input, catalog);
}
