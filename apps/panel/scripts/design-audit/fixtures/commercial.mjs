import { IDS, member, workspace } from "./session.mjs";

const UNIT_ID = "qa-unit-0001";
const UNIT_ID_2 = "qa-unit-0002";
const CATEGORY_ID = "qa-category-0001";
const PARTNER_ID = "qa-partner-0001";
const STAGE_NEW = "qa-stage-new";
const STAGE_QUALIFIED = "qa-stage-qualified";
const STAGE_NEGOTIATION = "qa-stage-negotiation";
const TAG_HOT = "qa-tag-hot";
const TAG_FOLLOW = "qa-tag-follow-up";
const LEAD_ID_2 = "qa-lead-0002";
const APPOINTMENT_ID = "qa-appointment-0001";
const BLOCK_ID = "qa-block-0001";
const NOW = "2026-08-20T12:00:00.000Z";
const TOMORROW = "2026-08-21T15:00:00.000Z";

const tags = [
  { id: TAG_HOT, name: "Alta intenção comercial", color: "#ef4444", archived: false },
  { id: TAG_FOLLOW, name: "Follow-up prioritário com nome propositalmente longo", color: "#8b5cf6", archived: false }
];
const stages = [
  { id: STAGE_NEW, name: "Novo contato comercial", color: "#168aad", position: 10, capacity_target: 40, technical_status: "novo", is_default: true },
  { id: STAGE_QUALIFIED, name: "Qualificado — decisão pendente", color: "#f59e0b", position: 20, capacity_target: 25, technical_status: "qualificado", is_default: false },
  { id: STAGE_NEGOTIATION, name: "Negociação em andamento", color: "#22c55e", position: 30, capacity_target: 20, technical_status: "em_negociacao", is_default: false }
];
const leadBase = {
  tenant: workspace.id, telefone: "+55 11 98888-0001", nome: "Cliente QA com nome comercial deliberadamente longo", avatar_url: null,
  categoria_interesse_id: CATEGORY_ID, unidade_id: UNIT_ID, parceiro_id: PARTNER_ID, status: "qualificado", origem: "facebook_ads",
  campanha: "Campanha QA deterministicamente populada", criado_em: "2026-08-19T10:00:00.000Z", atualizado_em: NOW,
  categoria_nome: "Consultoria empresarial premium", unidade_nome: "Unidade Paulista — Atendimento comercial", parceiro_nome: "Parceiro de referência estratégica",
  interesse: "Consultoria empresarial premium", situacao: "qualificado", origem_facebook: { source_type: "click_to_whatsapp", source_id: "qa-source-0001", headline: "Anúncio de alta intenção" },
  pipeline_stage_id: STAGE_QUALIFIED, pipeline_stage: stages[1], tags: [tags[0]], sdr_member_id: member.id, closer_member_id: member.id,
  recovery_required: false, recovery_member_id: null, recovery_email: null, handoff_at: null, handoff_by_user_id: null,
  commercial_outcome: "em_negociacao", outcome_metadata: { source: "qa-fixture" }, sale_value: null, loss_reason: null, loss_reason_note: null,
  commercial_updated_at: NOW, commercial_updated_by_user_id: IDS.user, sdr_email: member.email, closer_email: member.email,
  responsavel_member_id: member.id, responsavel_email: member.email, responsavel_disponibilidade: "available",
  proxima_acao: "Confirmar escopo da proposta comercial", proxima_acao_em: TOMORROW, ai_follow_up: { count: 2, status: "scheduled", next_run_at: TOMORROW, cancellation_reason: null },
  qualificacao: { estrelas: 5, respostas: { objetivo: "Expandir operação", prazo: "Este trimestre" }, resumo: "Lead pronto para proposta e reunião de alinhamento.", justificativa: "Necessidade e prazo claros", avaliado_em: NOW, requer_decisao_humana: false, origem_facebook: { source_type: "click_to_whatsapp", headline: "Anúncio de alta intenção" } }
};
const lead = { id: IDS.lead, ...leadBase };
const lead2 = { ...leadBase, id: LEAD_ID_2, nome: "Mariana Oliveira — expansão regional e planejamento", telefone: "+55 11 97777-0002", status: "novo", situacao: "novo", pipeline_stage_id: STAGE_NEW, pipeline_stage: stages[0], tags: [tags[1]], commercial_outcome: "follow_up", sale_value: null, qualificacao: null, proxima_acao: "Enviar material de apresentação", proxima_acao_em: "2026-08-22T13:30:00.000Z" };
const appointment = {
  id: APPOINTMENT_ID, lead_id: IDS.lead, tenant: workspace.id, unit_id: UNIT_ID, unit_name: "Unidade Paulista — Atendimento comercial", unidade_id: UNIT_ID,
  start: TOMORROW, end: "2026-08-21T15:45:00.000Z", duration_min: 45, timezone: workspace.timezone, status: "confirmado", result_pending_at: null,
  commercial_outcome: null, sale_value: null, loss_reason: null, loss_reason_note: null, outcome_next_action: null, outcome_next_action_at: null,
  outcome_metadata: {}, finalized_by_user_id: null, finalized_at: null, cancellation_disposition: null, created_by_user_id: IDS.user,
  meeting_provisioning_status: "not_required", meeting_provider: null, meeting_url: null, meeting_code: null, criado_em: NOW, atualizado_em: NOW,
  lead_nome: lead.nome, lead_telefone: lead.telefone, unidade_nome: "Unidade Paulista — Atendimento comercial", conversation_id: null, observacao: "Levar proposta e mapa de implantação.",
  responsavel: { member_id: member.id, user_id: "qa-member-user", email: member.email, availability_status: "available", cor_agenda: "#2563EB" }, atribuido_em: NOW, meet_link: null, meet: null
};
const units = [
  { id: UNIT_ID, tenant: workspace.id, nome: "Unidade Paulista — Atendimento comercial", horario_abertura: "08:00", horario_fechamento: "18:00", dias_funcionamento: [1, 2, 3, 4, 5], duracao_slot_min: 45, capacidade_simultanea: 2 },
  { id: UNIT_ID_2, tenant: workspace.id, nome: "Unidade Centro — Consultoria e demonstrações", horario_abertura: "09:00", horario_fechamento: "17:00", dias_funcionamento: [1, 2, 3, 4, 5], duracao_slot_min: 30, capacidade_simultanea: 1 }
];
const slots = [
  { start: "2026-08-21T13:00:00.000Z", end: "2026-08-21T13:45:00.000Z", vagas: 2, capacidade: 2, ocupados_no_inicio: 0 },
  { start: "2026-08-21T15:00:00.000Z", end: "2026-08-21T15:45:00.000Z", vagas: 1, capacidade: 2, ocupados_no_inicio: 1 }
];
const attendees = [
  { member_id: member.id, user_id: "qa-member-user", email: member.email, funcao: "Closer comercial", selected: true, availability_status: "available", availability_changed_at: NOW, availability_changed_by_email: member.email, cor_agenda: "#2563EB", active_appointments: 1, last_assigned_at: NOW, is_current: true },
  { member_id: "qa-member-0002", user_id: "qa-member-user-2", email: "bruno.comercial@example.test", funcao: "SDR comercial", selected: true, availability_status: "available", availability_changed_at: NOW, availability_changed_by_email: member.email, cor_agenda: "#16A34A", active_appointments: 0, last_assigned_at: "2026-08-19T11:00:00.000Z", is_current: true }
];
const leadDetail = { lead, qualificacao: lead.qualificacao, eventos: [{ id: "qa-event-0001", event_type: "status_alterado", previous_status: "em_atendimento", new_status: "qualificado", details: { source: "qa-fixture" }, actor_user_id: IDS.user, created_at: NOW }], agendamentos: [appointment], status_permitidos: ["agendado", "em_negociacao", "proposta_enviada", "follow_up", "perdido"], timezone: workspace.timezone };
const followUp = { follow_up: { responsavel: { member_id: member.id, user_id: "qa-member-user", email: member.email, availability_status: "available" }, proxima_acao: lead.proxima_acao, proxima_acao_em: lead.proxima_acao_em, timezone: workspace.timezone }, notas: [{ id: "qa-note-0001", nota: "qa-note — Cliente confirmou interesse e solicitou proposta detalhada.", autor_user_id: IDS.user, autor_email: "qa@example.test", criado_em: NOW }, { id: "qa-note-0002", nota: "Reunião de alinhamento marcada com o closer.", autor_user_id: IDS.user, autor_email: "qa@example.test", criado_em: "2026-08-20T13:00:00.000Z" }], responsaveis: attendees.map(({ member_id, user_id, email, funcao, availability_status }) => ({ member_id, user_id, email, funcao, availability_status })) };
const savedViews = [
  { id: "qa-view-0001", name: "Leads quentes desta semana — comercial", resource: "leads", filters: { status: "qualificado", estrelas: 5 }, shared: true, owner_user_id: IDS.user },
  { id: "qa-view-0002", name: "Follow-ups prioritários com ação pendente", resource: "leads", filters: { status: "follow_up", fila_humana: "true" }, shared: false, owner_user_id: IDS.user }
];
const metricResult = { new_contacts: 12, appointments: 6, calls: 4, no_show: 1, sales: 2, sold_value: 18500, average_ticket: 9250 };
const series = [1, 2, 3, 4, 5, 6, 7].map((day, i) => ({ day: `2026-08-${String(13 + day).padStart(2, "0")}`, scheduled: i + 1, completed: Math.max(0, i - 1), no_show: i === 3 ? 1 : 0, cancelled: i === 2 ? 1 : 0 }));
const widgetCatalog = [{ key: "commercial_metrics", label: "Métricas comerciais", description: "Indicadores de vendas e reuniões.", group: "vendas", sizes: ["medium", "wide", "full"], default_size: "wide", selectable: true }, { key: "new_leads", label: "Novos leads", description: "Leads criados no período.", group: "atendimento", sizes: ["small", "medium"], default_size: "small", selectable: true }, { key: "sales_value", label: "Valor vendido", description: "Receita fechada.", group: "vendas", sizes: ["small", "medium"], default_size: "small", selectable: true }];
const widgetLayout = { layout: { items: widgetCatalog.map((w, order) => ({ key: w.key, order, visible: true, size: w.default_size })), source: "default" } };

const qaPipelines = [
  { id: "qa-pipeline-0001", name: "Pipeline — Boleto", color: "#3B82F6", position: 0, is_default: true, enforce_transitions: false, stage_count: 3, lead_count: 2, channel_ids: ["qa-session-0001"] },
  { id: "qa-pipeline-0002", name: "Pipeline — À Vista", color: "#22C55E", position: 1, is_default: false, enforce_transitions: false, stage_count: 5, lead_count: 0, channel_ids: ["qa-session-0002"] }
];

export function commercialFixture(path) {
  if (path === "/dashboard") return { connection: { status: "connected" }, counts: { handoff: 2, handoff_unassigned: 1, handoff_over_sla: 1, oldest_handoff_minutes: 27, open: 8, ai_open: 5, resolved_today: 11, messagesToday: 126 }, agent: { is_active: true, ai_model: "gpt-5.6-luna" }, handoffs: [{ id: "qa-handoff-0001", contact_name: "Mariana Oliveira", contact_phone: lead2.telefone, avatar_url: null, handoff_reason: "decision_human", waiting_minutes: 27, assigned_user_email: member.email }, { id: "qa-handoff-0002", contact_name: "Rafael Souza", contact_phone: "+55 11 96666-0003", avatar_url: null, handoff_reason: "complex_question", waiting_minutes: 8, assigned_user_email: null }], commercial: { scope: { type: "workspace", member_id: member.id, email: member.email, is_closer: true, is_attendant: true, availability_status: "available" }, result: metricResult, series, period: { key: "today", start: "2026-08-20", end: "2026-08-20", timezone: workspace.timezone }, metrics: { created: 12, scheduled: 6, completed: 4, no_show: 1, cancelled: 1, upcoming: 2, overdue: 0, result_pending: 1, rescheduled: 0, proposals: 3, negotiations: 2, sales: 2, closing_rate: 16.7, sold_value: 18500, average_ticket: 9250, overdue_follow_ups: 1, attendance_rate: 66.7, no_show_rate: 16.7, average_quality: null }, sdr_metrics: { received: 12, attended: 8, qualified: 5, scheduled: 6, qualification_rate: 41.7, scheduling_rate: 50, average_first_response_minutes: 8, overdue_follow_ups: 1, recovered_no_shows: 1 }, commercial_metrics: { scheduled: 6, completed: 4, attended: 4, no_show: 1, rescheduled: 0, cancelled: 1, result_pending: 1, proposals: 3, negotiations: 2, sales: 2, attendance_rate: 66.7, closing_rate: 16.7, sold_value: 18500, average_ticket: 9250, overdue_follow_ups: 1 }, today_agenda: [], team: [] } };
  if (path === "/dashboard/widgets/catalog") return { widgets: widgetCatalog, default_layout: widgetLayout.layout.items };
  if (path === "/dashboard/widgets/layout") return widgetLayout;
  if (path.startsWith("/dashboard/widgets/")) { const key = path.split("/").at(-1); return { key, data: key === "commercial_metrics" ? { result: metricResult, series } : key === "new_leads" ? { value: 12 } : { value: 18500, currency: "BRL" } }; }
  if (path === "/leads" || path.startsWith("/leads?")) return { leads: [lead, lead2], total: 2, next_cursor: null, stages };
  if (path === `/contatos/${IDS.lead}` || path === `/scheduling/leads/${IDS.lead}`) return leadDetail;
  if (path === `/contatos/${IDS.lead}/follow-up` || path === `/scheduling/leads/${IDS.lead}/follow-up`) return followUp;
  if (path === "/pipeline") return { leads: [lead, lead2], stages, transitions: stages.flatMap((from) => stages.filter((to) => to.id !== from.id).map((to) => ({ from_stage_id: from.id, to_stage_id: to.id }))), follow_up_config: { enabled: true, default_days: 2 }, enforce_transitions: false, timezone: workspace.timezone };
  if (path === "/organization/pipelines") return { pipelines: qaPipelines, channels: [{ id: "qa-session-0001", label: "WhatsApp vendas no boleto", channel: "whatsapp", phone_number: "+55 11 97777-0001", pipeline_id: "qa-pipeline-0001" }, { id: "qa-session-0002", label: "WhatsApp vendas à vista", channel: "whatsapp", phone_number: "+55 11 97777-0002", pipeline_id: "qa-pipeline-0002" }] };
  if (path === "/organization/pipeline") return { pipeline: qaPipelines[0], stages, transitions: stages.flatMap((from) => stages.filter((to) => to.id !== from.id).map((to) => ({ from_stage_id: from.id, to_stage_id: to.id }))), follow_up_config: { enabled: true, default_days: 2 }, enforce_transitions: false };
  if (path === "/organization/saved-views") return { saved_views: savedViews };
  if (path === "/organization/tags" || path.startsWith("/organization/tags?")) return { tags };
  if (path === "/organization/loss-reasons") return { motivos: [{ id: "qa-loss-price", nome: "Preço fora do orçamento", ativo: true }, { id: "qa-loss-timing", nome: "Sem timing para decisão", ativo: true }] };
  if (path === "/scheduling/leads") return { leads: [lead, lead2], timezone: workspace.timezone };
  if (path === "/scheduling/appointments") return { agendamentos: [appointment], timezone: workspace.timezone };
  if (path === "/scheduling/config/unidades") return { unidades: units };
  if (path === "/scheduling/config/categorias") return { categorias: [{ id: CATEGORY_ID, tenant: workspace.id, nome: "Consultoria empresarial premium", ativa: true }, { id: "qa-category-0002", tenant: workspace.id, nome: "Treinamento de equipes", ativa: true }] };
  if (path === "/scheduling/config/parceiros") return { parceiros: [{ id: PARTNER_ID, tenant: workspace.id, nome: "Parceiro de referência estratégica", ordem_prioridade: 1, link_proposta: "https://example.test/proposta/qa", ativo: true }, { id: "qa-partner-0002", tenant: workspace.id, nome: "Indicação regional de confiança", ordem_prioridade: 2, link_proposta: null, ativo: true }] };
  if (path === "/scheduling/config/notifications") return { notifications: { enabled: false, session_id: null, group_jid: null, group_name: null } };
  if (path === "/scheduling/config/notification-groups") return { groups: [{ id: "qa-group-0001", subject: "Grupo comercial QA", jid: "120363000000000001@g.us" }] };
  if (path === "/scheduling/config/attendants") return { attendants: attendees, member_ids: attendees.filter((a) => a.selected).map((a) => a.member_id), redistribuidos: 0, redistribuidos_leads: 0, redistribuidos_conversas: 0, redistribuidos_reunioes: 0 };
  if (path === "/scheduling/config/atendon-meet") return { enabled: false };
  if (path === "/scheduling/config/google-meet") return { connected: false, email: null, calendar_id: null, calendar_name: null, timezone: workspace.timezone };
  if (path === "/scheduling/attendants/me/time-blocks") return { blocks: [{ id: BLOCK_ID, member_id: member.id, start: "2026-08-21T16:00:00.000Z", end: "2026-08-21T17:00:00.000Z", reason: "Bloqueio reservado para revisão de propostas", created_at: NOW }] };
  if (path === "/scheduling/attendants/me/recurring-time-blocks") return { blocks: [{ id: "qa-recurring-0001", member_id: member.id, start_local_time: "12:00", end_local_time: "13:00", weekdays: [1, 3, 5], starts_on: "2026-08-01", ends_on: null, timezone: workspace.timezone, reason: "Almoço comercial", active: true }] };
  if (path.startsWith("/scheduling/availability")) return { data: "2026-08-21", timezone: workspace.timezone, horarios: slots };
  if (path === "/scheduling/appointment-assignees") return { assignees: attendees.map((a, i) => ({ member_id: a.member_id, user_id: a.user_id, name: i ? "Bruno Comercial" : "Ana QA", email: a.email, online: true, availability_status: a.availability_status, future_meetings_count: a.active_appointments, conflicts: [], selectable: true, suggested: i === 0 })), can_select_assignee: true, suggested_member_id: member.id };
}

export { lead, lead2, appointment, units, stages, tags };
