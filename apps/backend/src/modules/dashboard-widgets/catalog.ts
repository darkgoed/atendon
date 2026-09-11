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
  "recent_alerts",
  "conversations_started",
  "active_conversations",
  "new_leads",
  "pending_follow_ups",
  "overdue_follow_ups",
  "leads_paid_traffic",
  "leads_referral",
  "leads_organic",
  "leads_other_sources",
  "appointments_count",
  "attendances",
  "no_shows",
  "reschedules",
  "attendance_rate",
  "sales_count",
  "sales_value",
  "average_ticket",
  "lost_sales",
  "conversion_rate",
  "sales_paid_traffic",
  "sales_referral",
  "sales_organic",
  "sales_by_seller",
  "sales_value_by_seller",
  "conversion_by_seller"
] as const;

export type DashboardWidgetKey = typeof DASHBOARD_WIDGET_KEYS[number];
export const DASHBOARD_WIDGET_SIZES = ["small", "medium", "wide", "full"] as const;
export type DashboardWidgetSize = typeof DASHBOARD_WIDGET_SIZES[number];
export const DASHBOARD_WIDGET_GROUPS = ["Atendimento", "Origem", "Agendamento", "Vendas", "Origem das vendas", "Equipe"] as const;
export type DashboardWidgetGroup = typeof DASHBOARD_WIDGET_GROUPS[number];

export interface DashboardWidgetDefinition {
  key: DashboardWidgetKey;
  label: string;
  description: string;
  group: DashboardWidgetGroup;
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
  { key: "commercial_metrics", label: "Resultado comercial", description: "Contatos, agendamentos, calls, no-show e vendas do período.", group: "Vendas", requiredPermissions: ["leads.read", "appointments.read"], sizes: ["wide", "full"], defaultSize: "full", defaultVisible: false },
  { key: "conversion_funnel", label: "Funil de conversão", description: "Lead → agendamento → call → venda e as taxas entre as etapas.", group: "Vendas", requiredPermissions: ["leads.read", "appointments.read"], sizes: ["medium", "wide", "full"], defaultSize: "full", defaultVisible: false },
  { key: "team_load", label: "Performance por closer", description: "Calls, no-shows, vendas e valor vendido por closer no período.", group: "Equipe", requiredPermissions: ["availability.read", "appointments.read"], sizes: ["medium", "wide", "full"], defaultSize: "full", defaultVisible: false },
  { key: "today_agenda", label: "Agenda do dia", description: "Próximos compromissos acessíveis ao usuário.", group: "Agendamento", requiredPermissions: ["appointments.read"], sizes: ["medium", "wide", "full"], defaultSize: "wide", defaultVisible: false },
  { key: "handoffs", label: "Handoffs na fila", description: "Conversas aguardando atendimento humano agora.", group: "Atendimento", requiredPermissions: ["conversations.read"], sizes: ["small", "medium", "wide"], defaultSize: "medium", defaultVisible: false },
  { key: "operations_summary", label: "Operação", description: "Mensagens, conversas, handoffs, resposta e pendências do período.", group: "Atendimento", requiredPermissions: ["leads.read", "conversations.read"], sizes: ["wide", "full"], defaultSize: "full", defaultVisible: false },
  { key: "whatsapp_connection", label: "Conexão WhatsApp", description: "Estado atual da conexão principal.", group: "Atendimento", requiredPermissions: ["connection.read"], sizes: ["small", "medium"], defaultSize: "small", defaultVisible: false },
  { key: "open_conversations", label: "Conversas abertas", description: "Conversas em andamento e resolvidas hoje.", group: "Atendimento", requiredPermissions: ["conversations.read"], sizes: ["small", "medium"], defaultSize: "small", defaultVisible: false },
  { key: "messages_today", label: "Mensagens hoje", description: "Volume de mensagens no dia.", group: "Atendimento", requiredPermissions: ["conversations.read"], sizes: ["small", "medium"], defaultSize: "small", defaultVisible: false },
  { key: "pipeline", label: "Pipeline", description: "Distribuição dos leads por situação.", group: "Vendas", requiredPermissions: ["leads.read"], sizes: ["medium", "wide", "full"], defaultSize: "wide", defaultVisible: false },
  { key: "recent_alerts", label: "Alertas recentes", description: "Sinais operacionais mais recentes.", group: "Atendimento", requiredPermissions: ["dashboard.read"], sizes: ["small", "medium", "wide"], defaultSize: "medium", defaultVisible: false },
  { key: "conversations_started", label: "Conversas iniciadas", description: "Conversas criadas no período selecionado.", group: "Atendimento", requiredPermissions: ["conversations.read"], sizes: ["small", "medium"], defaultSize: "small", defaultVisible: true },
  { key: "active_conversations", label: "Conversas ativas", description: "Conversas abertas no momento.", group: "Atendimento", requiredPermissions: ["conversations.read"], sizes: ["small", "medium"], defaultSize: "small", defaultVisible: false },
  { key: "new_leads", label: "Novos leads", description: "Leads criados no período selecionado.", group: "Atendimento", requiredPermissions: ["leads.read"], sizes: ["small", "medium"], defaultSize: "small", defaultVisible: false },
  { key: "pending_follow_ups", label: "Próximos follow-ups", description: "Follow-ups futuros pendentes no momento.", group: "Atendimento", requiredPermissions: ["leads.read"], sizes: ["small", "medium"], defaultSize: "small", defaultVisible: false },
  { key: "overdue_follow_ups", label: "Follow-ups vencidos", description: "Follow-ups pendentes com prazo vencido.", group: "Atendimento", requiredPermissions: ["leads.read"], sizes: ["small", "medium"], defaultSize: "small", defaultVisible: false },
  { key: "leads_paid_traffic", label: "Leads de tráfego pago", description: "Leads do período atribuídos a mídia paga.", group: "Origem", requiredPermissions: ["leads.read"], sizes: ["small", "medium"], defaultSize: "small", defaultVisible: false },
  { key: "leads_referral", label: "Leads por indicação", description: "Leads do período originados por indicação.", group: "Origem", requiredPermissions: ["leads.read"], sizes: ["small", "medium"], defaultSize: "small", defaultVisible: false },
  { key: "leads_organic", label: "Leads orgânicos", description: "Leads do período vindos de canais orgânicos.", group: "Origem", requiredPermissions: ["leads.read"], sizes: ["small", "medium"], defaultSize: "small", defaultVisible: false },
  { key: "leads_other_sources", label: "Leads de outras origens", description: "Leads do período sem outra classificação de origem.", group: "Origem", requiredPermissions: ["leads.read"], sizes: ["small", "medium"], defaultSize: "small", defaultVisible: false },
  { key: "appointments_count", label: "Agendamentos", description: "Agendamentos do período selecionado.", group: "Agendamento", requiredPermissions: ["appointments.read"], sizes: ["small", "medium"], defaultSize: "small", defaultVisible: true },
  { key: "attendances", label: "Comparecimentos", description: "Agendamentos concluídos no período.", group: "Agendamento", requiredPermissions: ["appointments.read"], sizes: ["small", "medium"], defaultSize: "small", defaultVisible: false },
  { key: "no_shows", label: "Não comparecimentos", description: "Agendamentos marcados como no-show no período.", group: "Agendamento", requiredPermissions: ["appointments.read"], sizes: ["small", "medium"], defaultSize: "small", defaultVisible: false },
  { key: "reschedules", label: "Reagendamentos", description: "Agendamentos reagendados no período.", group: "Agendamento", requiredPermissions: ["appointments.read"], sizes: ["small", "medium"], defaultSize: "small", defaultVisible: false },
  { key: "attendance_rate", label: "Taxa de comparecimento", description: "Percentual de comparecimentos sobre agendamentos do período.", group: "Agendamento", requiredPermissions: ["appointments.read"], sizes: ["small", "medium"], defaultSize: "small", defaultVisible: false },
  { key: "sales_count", label: "Vendas", description: "Leads fechados no período selecionado.", group: "Vendas", requiredPermissions: ["leads.read", "appointments.read"], sizes: ["small", "medium"], defaultSize: "small", defaultVisible: true },
  { key: "sales_value", label: "Valor vendido", description: "Valor total das vendas fechadas no período.", group: "Vendas", requiredPermissions: ["leads.read", "appointments.read"], sizes: ["small", "medium"], defaultSize: "small", defaultVisible: true },
  { key: "average_ticket", label: "Ticket médio", description: "Valor médio por venda fechada no período.", group: "Vendas", requiredPermissions: ["leads.read", "appointments.read"], sizes: ["small", "medium"], defaultSize: "small", defaultVisible: false },
  { key: "lost_sales", label: "Vendas perdidas", description: "Leads marcados como perdidos no período.", group: "Vendas", requiredPermissions: ["leads.read", "appointments.read"], sizes: ["small", "medium"], defaultSize: "small", defaultVisible: false },
  { key: "conversion_rate", label: "Taxa de conversão", description: "Percentual de vendas sobre conversas iniciadas no período.", group: "Vendas", requiredPermissions: ["leads.read", "appointments.read"], sizes: ["small", "medium"], defaultSize: "small", defaultVisible: true },
  { key: "sales_paid_traffic", label: "Vendas de tráfego pago", description: "Vendas do período atribuídas a mídia paga.", group: "Origem das vendas", requiredPermissions: ["leads.read", "appointments.read"], sizes: ["small", "medium"], defaultSize: "small", defaultVisible: false },
  { key: "sales_referral", label: "Vendas por indicação", description: "Vendas do período originadas por indicação.", group: "Origem das vendas", requiredPermissions: ["leads.read", "appointments.read"], sizes: ["small", "medium"], defaultSize: "small", defaultVisible: false },
  { key: "sales_organic", label: "Vendas orgânicas", description: "Vendas do período vindas de canais orgânicos.", group: "Origem das vendas", requiredPermissions: ["leads.read", "appointments.read"], sizes: ["small", "medium"], defaultSize: "small", defaultVisible: false },
  { key: "sales_by_seller", label: "Vendas por vendedor", description: "Quantidade de vendas por vendedor no período.", group: "Equipe", requiredPermissions: ["availability.read", "appointments.read"], sizes: ["small", "medium"], defaultSize: "small", defaultVisible: false },
  { key: "sales_value_by_seller", label: "Valor vendido por vendedor", description: "Valor das vendas por vendedor no período.", group: "Equipe", requiredPermissions: ["availability.read", "appointments.read"], sizes: ["small", "medium"], defaultSize: "small", defaultVisible: false },
  { key: "conversion_by_seller", label: "Conversão por vendedor", description: "Percentual de vendas sobre atendimentos por vendedor.", group: "Equipe", requiredPermissions: ["availability.read", "appointments.read"], sizes: ["small", "medium"], defaultSize: "small", defaultVisible: false }
];

export const DASHBOARD_PRESET_KEYS = ["essencial", "comercial", "gestao_completa"] as const;
export type DashboardPresetKey = typeof DASHBOARD_PRESET_KEYS[number];

export const DASHBOARD_PRESETS: Record<DashboardPresetKey, { label: string; description: string; keys: readonly DashboardWidgetKey[] }> = {
  essencial: {
    label: "Essencial",
    description: "Conversas iniciadas, agendamentos, vendas, valor vendido e conversão.",
    keys: ["conversations_started", "appointments_count", "sales_count", "sales_value", "conversion_rate"]
  },
  comercial: {
    label: "Comercial",
    description: "Acrescenta comparecimentos e vendas perdidas ao essencial.",
    keys: ["conversations_started", "appointments_count", "attendances", "sales_count", "lost_sales", "conversion_rate"]
  },
  gestao_completa: {
    label: "Gestão completa",
    description: "Todos os principais indicadores, mais origem e desempenho por vendedor.",
    keys: [
      "conversations_started", "active_conversations", "new_leads", "pending_follow_ups", "overdue_follow_ups",
      "leads_paid_traffic", "leads_referral", "leads_organic", "leads_other_sources",
      "appointments_count", "attendances", "no_shows", "reschedules", "attendance_rate",
      "sales_count", "sales_value", "average_ticket", "lost_sales", "conversion_rate",
      "sales_paid_traffic", "sales_referral", "sales_organic",
      "sales_by_seller", "sales_value_by_seller", "conversion_by_seller"
    ]
  }
};

/** Ordena primeiro o preset permitido; todo o restante continua catalogado, mas oculto. */
export function dashboardLayoutFromPreset(
  preset: DashboardPresetKey,
  catalog: readonly DashboardWidgetDefinition[]
): DashboardLayoutItem[] {
  const byKey = new Map(catalog.map((widget) => [widget.key, widget]));
  const selected = DASHBOARD_PRESETS[preset].keys.flatMap((key) => {
    const definition = byKey.get(key);
    return definition ? [definition] : [];
  });
  const selectedKeys = new Set(selected.map((widget) => widget.key));
  return [...selected, ...catalog.filter((widget) => !selectedKeys.has(widget.key))]
    .map((widget, order) => ({ key: widget.key, order, visible: selectedKeys.has(widget.key), size: widget.defaultSize }));
}

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
  // Layout salvo é uma escolha explícita: chaves lançadas depois entram ocultas.
  // Somente um layout novo usa os cinco defaults do catálogo.
  for (const definition of catalog) {
    if (seen.has(definition.key)) continue;
    items.push({
      key: definition.key,
      order: items.length,
      visible: false,
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
