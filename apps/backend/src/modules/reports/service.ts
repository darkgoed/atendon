// ONDA 2-B (SPEC v7) — B1 Reports + B9 Dashboard (novos keys).
// Agregações sobre tabelas EXISTENTES (conversations, messages, users,
// workspace_members, audit_logs, scheduling_leads, pipeline_stages,
// scheduling_lead_events). Tenancy (tenant_id da sessão) em toda query.
// Auditoria de relatórios NÃO é duplicada: a UI reusa o endpoint existente de
// /workspace/audit — este módulo só consome audit_logs para atribuir
// encerramentos de conversa ao operador (action 'conversation.resolved').
//
// Predicado de "aguardando resposta" é o mesmo do contact-ops
// (listAwaitingReply): conversa aberta cuja ÚLTIMA mensagem é do contato
// (cliente falou por último e ninguém respondeu) — os itens reaproveitam a
// função; o agregado (count/avg) replica o predicado porque precisa varrer a
// fila inteira, não uma página. O escopo de conversas usa scope.userId
// (assigned_user_id), o de leads usa scope.memberId (assigned_member_id) —
// convenção de auth/case-scope.ts.
import { Readable } from "node:stream";
import type { CaseScope } from "../../auth/case-scope.js";
import { conversationScopeCondition, leadScopeCondition } from "../../auth/case-scope.js";
import { db } from "../../db/client.js";
import { localDateKey, localDateTimeToUtc } from "../../timezone.js";
import { LEAD_TECHNICAL_STATUSES } from "../organization/domain.js";
import { httpError } from "../scheduling/service.js";
import { listAwaitingReply } from "../contact-ops/service.js";
import { shiftDateKey } from "../reporting.js";

export type ReportQuery = { from: string; to: string };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_REPORT_DAYS = 366;

export interface ReportRange { start: Date; end: Date; from: string; to: string }

export function resolveReportRange(from: string | undefined, to: string | undefined, timezone: string): ReportRange {
  const nowKey = localDateKey(new Date(), timezone);
  const end = to ?? nowKey;
  const start = from ?? shiftDateKey(end, -29);
  for (const value of [start, end]) {
    if (!ISO_DATE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00.000Z`))) {
      throw httpError(400, "Datas devem usar o formato AAAA-MM-DD");
    }
  }
  if (end < start) throw httpError(400, "A data final deve ser igual ou posterior à inicial");
  const days = Math.round((Date.parse(`${end}T00:00:00.000Z`) - Date.parse(`${start}T00:00:00.000Z`)) / 86_400_000);
  if (days > MAX_REPORT_DAYS) throw httpError(400, `O período pode ter no máximo ${MAX_REPORT_DAYS + 1} dias`);
  return {
    from: start,
    to: end,
    start: localDateTimeToUtc(start, "00:00", timezone),
    end: localDateTimeToUtc(shiftDateKey(end, 1), "00:00", timezone)
  };
}

export async function loadTenantTimezone(tenantId: string): Promise<string> {
  const result = await db.query<{ timezone: string }>("SELECT timezone FROM tenants WHERE id=$1", [tenantId]);
  return result.rows[0]?.timezone ?? "UTC";
}

/** Preenche dias ausentes com zero — a série do gráfico é contínua. */
function fillDays(from: string, to: string, rows: Map<string, { total: number; open: number; closed: number; pending: number }>) {
  const points: Array<{ date: string; total: number; open: number; closed: number; pending: number }> = [];
  let key = from;
  let guard = 0;
  while (key <= to && guard <= MAX_REPORT_DAYS + 1) {
    const row = rows.get(key) ?? { total: 0, open: 0, closed: 0, pending: 0 };
    points.push({ date: key, total: row.total, open: row.open, closed: row.closed, pending: row.pending });
    key = shiftDateKey(key, 1);
    guard += 1;
  }
  return points;
}

/**
 * GET /reports/conversation-volume — {points:[{date,total,open,closed,pending}]}.
 * open/closed são o estado ATUAL das conversas criadas no dia; pending são as
 * que seguem abertas aguardando resposta (predicado awaiting-reply).
 */
export async function loadConversationVolume(tenantId: string, scope: CaseScope, range: ReportRange, timezone: string) {
  const result = await db.query<{ date: string; total: number; open: number; closed: number; pending: number }>(
    `SELECT to_char(c.created_at AT TIME ZONE $3::text,'YYYY-MM-DD') date,
            count(*)::int total,
            count(*) FILTER (WHERE c.status='open')::int open,
            count(*) FILTER (WHERE c.status='closed')::int closed,
            count(*) FILTER (WHERE c.status='open' AND latest_message.sender='contact')::int pending
     FROM conversations c
     LEFT JOIN LATERAL (
       SELECT message.sender FROM messages message
       WHERE message.conversation_id=c.id
       ORDER BY message.created_at DESC, message.id DESC
       LIMIT 1
     ) latest_message ON true
     WHERE c.tenant_id=$1
       AND c.created_at >= $4::timestamptz AND c.created_at < $5::timestamptz
       AND (${conversationScopeCondition(scope, "c", "$2")})
     GROUP BY 1`,
    [tenantId, scope.userId, timezone, range.start.toISOString(), range.end.toISOString()]
  );
  const byDay = new Map(result.rows.map((row) => [row.date, row]));
  return { points: fillDays(range.from, range.to, byDay) };
}

/**
 * GET /reports/agent-productivity — {items:[{user_id,name,answered,closed,messages_sent}]}.
 * answered = conversas distintas em que o operador enviou mensagem no período;
 * messages_sent = mensagens enviadas (messages.sent_by_user_id); closed =
 * encerramentos atribuídos via auditoria existente ('conversation.resolved').
 */
export async function loadAgentProductivity(tenantId: string, scope: CaseScope, range: { start: Date; end: Date }) {
  const result = await db.query<{ user_id: string; name: string; email: string; answered: number; closed: number; messages_sent: number }>(
    `SELECT m.user_id,
            COALESCE(NULLIF(u.name,''),u.email) name,
            u.email,
            (SELECT count(DISTINCT msg.conversation_id)::int FROM messages msg
              WHERE msg.sent_by_user_id=m.user_id
                AND msg.created_at >= $2::timestamptz AND msg.created_at < $3::timestamptz) answered,
            (SELECT count(*)::int FROM audit_logs a
              WHERE a.workspace_id=m.workspace_id AND a.actor_user_id=m.user_id
                AND a.action='conversation.resolved'
                AND a.created_at >= $2::timestamptz AND a.created_at < $3::timestamptz) closed,
            (SELECT count(*)::int FROM messages msg
              WHERE msg.sent_by_user_id=m.user_id
                AND msg.created_at >= $2::timestamptz AND msg.created_at < $3::timestamptz) messages_sent
     FROM workspace_members m
     JOIN users u ON u.id=m.user_id
     WHERE m.workspace_id=$1 AND m.status='active'
       AND ($4::boolean OR m.user_id=$5::uuid)
     ORDER BY messages_sent DESC, name`,
    [tenantId, range.start.toISOString(), range.end.toISOString(), scope.type === "workspace", scope.userId]
  );
  return { items: result.rows.map((row) => ({ user_id: row.user_id, name: row.name, email: row.email, answered: row.answered, closed: row.closed, messages_sent: row.messages_sent })) };
}

// Catálogo canônico de status de lead (CHECK do banco, organization/domain.ts).
// A lista da era 0098 omitia status reais (novo, em_atendimento, …) e exibia
// status que não existem mais — o painel mostraria um fluxo de status falso.
const LEAD_STATUSES = LEAD_TECHNICAL_STATUSES;

/**
 * GET /reports/status-flow — {items:[{status,total,avg_close_minutes}]}.
 * Conversas do período agrupadas pelo status técnico atual do lead; média de
 * fechamento (criada → resolved_at) sobre as que já estão encerradas.
 */
export async function loadStatusFlow(tenantId: string, scope: CaseScope, range: { start: Date; end: Date }) {
  const result = await db.query<{ status: string; total: number; avg_close_minutes: string | null }>(
    `SELECT l.status,
            count(*)::int total,
            round(avg(EXTRACT(EPOCH FROM (c.resolved_at-c.created_at))/60)::numeric,1)::text avg_close_minutes
     FROM conversations c
     JOIN scheduling_leads l ON l.tenant_id=c.tenant_id AND l.id=c.lead_id AND l.deleted_at IS NULL
     WHERE c.tenant_id=$1
       AND c.created_at >= $2::timestamptz AND c.created_at < $3::timestamptz
       AND (${conversationScopeCondition(scope, "c", "$4")})
     GROUP BY l.status`,
    [tenantId, range.start.toISOString(), range.end.toISOString(), scope.userId]
  );
  const byStatus = new Map(result.rows.map((row) => [row.status, row]));
  const statuses = [...LEAD_STATUSES, ...result.rows.map((row) => row.status).filter((status) => !(LEAD_STATUSES as readonly string[]).includes(status))];
  return {
    items: statuses.map((status) => {
      const row = byStatus.get(status);
      return {
        status,
        total: row?.total ?? 0,
        avg_close_minutes: row?.avg_close_minutes ? Number(row.avg_close_minutes) : null
      };
    })
  };
}

export interface QueueWaitingSnapshot {
  count: number;
  avg_wait_seconds: number | null;
  items: Array<{ conversation_id: string; contact: { phone: string; name: string | null }; waiting_since_seconds: number | null; last_inbound_at: string | null }>;
}

/**
 * Snapshot da fila aguardando resposta (predicado awaiting-reply do
 * contact-ops): agregado sobre a fila inteira + itens reaproveitando
 * listAwaitingReply.
 */
export async function loadQueueWaiting(tenantId: string, scope: CaseScope, options: { limit?: number; now?: Date } = {}): Promise<QueueWaitingSnapshot> {
  const limit = Math.min(Math.max(options.limit ?? 5, 1), 100);
  const now = options.now ?? new Date();
  const [aggregate, listed] = await Promise.all([
    db.query<{ count: number; avg_wait_seconds: string | null }>(
      `SELECT count(*)::int count,
              round(avg(EXTRACT(EPOCH FROM (now()-latest_contact.created_at)))::numeric,0)::text avg_wait_seconds
       FROM conversations c
       LEFT JOIN LATERAL (
         SELECT message.sender FROM messages message
         WHERE message.conversation_id=c.id
         ORDER BY message.created_at DESC, message.id DESC
         LIMIT 1
       ) latest_message ON true
       LEFT JOIN LATERAL (
         SELECT m.created_at FROM messages m
         WHERE m.conversation_id=c.id AND m.sender='contact'
         ORDER BY m.created_at DESC, m.id DESC
         LIMIT 1
       ) latest_contact ON true
       WHERE c.tenant_id=$1 AND c.status='open' AND latest_message.sender='contact'
         AND (${conversationScopeCondition(scope, "c", "$2")})`,
      [tenantId, scope.userId]
    ),
    listAwaitingReply(tenantId, scope, { limit })
  ]);
  const items = listed.items.map((item) => {
    const waiting = item.last_inbound_at ? Math.max(0, Math.round((now.getTime() - Date.parse(item.last_inbound_at)) / 1000)) : null;
    return {
      conversation_id: item.conversation_id,
      contact: { phone: item.contact.phone, name: item.contact.name },
      waiting_since_seconds: waiting,
      last_inbound_at: item.last_inbound_at
    };
  });
  return {
    count: aggregate.rows[0]?.count ?? 0,
    avg_wait_seconds: aggregate.rows[0]?.avg_wait_seconds ? Number(aggregate.rows[0].avg_wait_seconds) : null,
    items
  };
}

export interface PipelineBottleneck {
  pipeline_id: string | null;
  stage_id: string;
  stage_name: string;
  contacts: number;
  avg_minutes: number | null;
}

/**
 * Gargalos de pipeline: tempo médio por etapa derivado dos eventos EXISTENTES
 * de mudança de etapa (pipeline_stage_updated, com details->new_stage_id) e da
 * entrada por agendamento (agendamento_criado, com details->pipeline_stage_id).
 * Para cada entrada de lead em etapa dentro da janela, a permanência termina
 * na PRÓXIMA mudança de etapa do mesmo lead; permanências ainda em curso não
 * entram na média. Contatos = leads atuais na etapa (escopo de leads).
 * pipeline_id é null: o AtendON tem um único pipeline por workspace (não há
 * tabela de pipelines).
 */
export async function loadPipelineBottlenecks(tenantId: string, scope: CaseScope, range: { start: Date; end: Date }, options: { limit?: number } = {}): Promise<{ items: PipelineBottleneck[] }> {
  const limit = Math.min(Math.max(options.limit ?? 5, 1), 20);
  const result = await db.query<{ stage_id: string; stage_name: string | null; contacts: number; avg_minutes: string | null; dwells: number }>(
    `WITH entries AS MATERIALIZED (
       SELECT e.lead_id,
              COALESCE(e.details->>'new_stage_id', e.details->>'pipeline_stage_id') stage_key,
              e.created_at entered_at
       FROM scheduling_lead_events e
       WHERE e.tenant_id=$1
         AND ((e.event_type='pipeline_stage_updated' AND e.details ? 'new_stage_id')
           OR (e.event_type='agendamento_criado' AND e.details ? 'pipeline_stage_id'))
         AND COALESCE(e.details->>'new_stage_id', e.details->>'pipeline_stage_id')
               ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         AND e.created_at >= $2::timestamptz
     ),
     paired AS (
       SELECT lead_id, stage_key, entered_at,
              LEAD(entered_at) OVER (PARTITION BY lead_id ORDER BY entered_at) left_at
       FROM entries
     ),
     scoped_leads AS MATERIALIZED (
       SELECT id, pipeline_stage_id
       FROM scheduling_leads
       WHERE tenant_id=$1 AND deleted_at IS NULL
         AND (${leadScopeCondition(scope, "scheduling_leads", "$3")})
     ),
     dwell AS (
       SELECT stage_key::uuid stage_id,
              count(*)::int dwells, -- toda entrada conta (mesmo a em curso)
              round(avg(EXTRACT(EPOCH FROM (left_at-entered_at))/60) FILTER (WHERE left_at IS NOT NULL)::numeric,1)::text avg_minutes
       FROM paired
       WHERE entered_at >= $2::timestamptz AND entered_at < $4::timestamptz
       GROUP BY 1
     )
     SELECT s.id stage_id,
            s.name stage_name,
            (SELECT count(*)::int FROM scoped_leads sl WHERE sl.pipeline_stage_id=s.id) contacts,
            dwell.avg_minutes,
            dwell.dwells
     FROM pipeline_stages s
     JOIN dwell ON dwell.stage_id=s.id -- gargalo = etapa com movimento real
     WHERE s.tenant_id=$1
     ORDER BY dwell.avg_minutes DESC NULLS LAST, dwell.dwells DESC NULLS LAST, s.position, s.id
     LIMIT $5`,
    [tenantId, range.start.toISOString(), scope.memberId, range.end.toISOString(), limit]
  );
  return {
    items: result.rows.map((row) => ({
      pipeline_id: null,
      stage_id: row.stage_id,
      stage_name: row.stage_name ?? "(etapa removida)",
      contacts: row.contacts,
      avg_minutes: row.avg_minutes ? Number(row.avg_minutes) : null,
      dwells: row.dwells
    }))
  };
}

export interface FirstResponseByOperatorItem {
  user_id: string;
  name: string;
  seconds: number | null;
  conversations: number;
}

/**
 * Primeira resposta por operador: para conversas criadas na janela, tempo
 * entre a 1ª mensagem do contato e a 1ª mensagem humana seguinte, atribuída
 * ao autor (messages.sent_by_user_id). Sem mensagem do contato, não mede.
 */
export async function loadFirstResponseByOperator(tenantId: string, scope: CaseScope, range: { start: Date; end: Date }): Promise<{ items: FirstResponseByOperatorItem[] }> {
  const result = await db.query<{ user_id: string; name: string; seconds: string; conversations: number }>(
    `WITH scoped AS MATERIALIZED (
       SELECT c.id
       FROM conversations c
       WHERE c.tenant_id=$1
         AND c.created_at >= $2::timestamptz AND c.created_at < $3::timestamptz
         AND (${conversationScopeCondition(scope, "c", "$4")})
     ),
     first_inbound AS (
       SELECT message.conversation_id, min(message.created_at) first_contact
       FROM messages message
       JOIN scoped ON scoped.id=message.conversation_id
       WHERE message.sender='contact'
       GROUP BY 1
     ),
     first_reply AS (
       SELECT DISTINCT ON (message.conversation_id)
              message.conversation_id, message.created_at, message.sent_by_user_id
       FROM messages message
       JOIN scoped ON scoped.id=message.conversation_id
       WHERE message.sender IN ('agent','human') AND message.sent_by_user_id IS NOT NULL
       ORDER BY message.conversation_id, message.created_at, message.id
     )
     SELECT reply.sent_by_user_id user_id,
            COALESCE(NULLIF(u.name,''),u.email) name,
            round(avg(EXTRACT(EPOCH FROM (reply.created_at-inbound.first_contact)))::numeric,0)::text seconds,
            count(*)::int conversations
     FROM first_inbound inbound
     JOIN first_reply reply ON reply.conversation_id=inbound.conversation_id AND reply.created_at > inbound.first_contact
     JOIN users u ON u.id=reply.sent_by_user_id
     WHERE inbound.first_contact IS NOT NULL
     GROUP BY reply.sent_by_user_id, u.name, u.email
     ORDER BY seconds, name`,
    [tenantId, range.start.toISOString(), range.end.toISOString(), scope.userId]
  );
  return {
    items: result.rows.map((row) => ({ user_id: row.user_id, name: row.name, seconds: Number(row.seconds), conversations: row.conversations }))
  };
}

/**
 * GET /reports/quality — agentes ociosos (sem envio no período), fila
 * aguardando resposta, primeira resposta por operador e gargalos de pipeline.
 */
export async function loadQualityReport(tenantId: string, scope: CaseScope, range: ReportRange) {
  const [idle, queue, firstResponse, bottlenecks] = await Promise.all([
    db.query<{ user_id: string; name: string; email: string; last_message_at: Date | null }>(
      `SELECT m.user_id, COALESCE(NULLIF(u.name,''),u.email) name, u.email,
              (SELECT max(msg.created_at) FROM messages msg WHERE msg.sent_by_user_id=m.user_id) last_message_at
       FROM workspace_members m
       JOIN users u ON u.id=m.user_id
       WHERE m.workspace_id=$1 AND m.status='active'
         AND NOT EXISTS (
           SELECT 1 FROM messages msg
           WHERE msg.sent_by_user_id=m.user_id
             AND msg.created_at >= $2::timestamptz AND msg.created_at < $3::timestamptz
         )
       ORDER BY name
       LIMIT 100`,
      [tenantId, range.start.toISOString(), range.end.toISOString()]
    ),
    loadQueueWaiting(tenantId, scope, { limit: 20 }),
    loadFirstResponseByOperator(tenantId, scope, range),
    loadPipelineBottlenecks(tenantId, scope, range)
  ]);
  return {
    from: range.from,
    to: range.to,
    idle_agents: idle.rows.map((row) => ({
      user_id: row.user_id,
      name: row.name,
      email: row.email,
      last_message_at: row.last_message_at ? row.last_message_at.toISOString() : null
    })),
    queue: { count: queue.count, avg_wait_seconds: queue.avg_wait_seconds, items: queue.items },
    avg_first_response: firstResponse.items.map(({ user_id, name, seconds }) => ({ user_id, name, seconds })),
    bottlenecks: bottlenecks.items.map(({ pipeline_id, stage_id, stage_name, contacts, avg_minutes }) => ({ pipeline_id, stage_id, stage_name, contacts, avg_minutes }))
  };
}

// ---------------------------------------------------------------------------
// Export CSV (padrão /usage/export: text/csv, content-disposition, csvCell com
// proteção anti-fórmula). Geradores em streaming; a fila pode ser longa e é
// percorrida com keyset, as demais agregações são limitadas pela janela.
// ---------------------------------------------------------------------------

function csvCell(value: unknown): string {
  const raw = String(value ?? "");
  const text = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csvLine(values: unknown[]): string {
  return `${values.map(csvCell).join(",")}\n`;
}

const QUEUE_CSV_PAGE = 500;
const QUEUE_CSV_LIMIT = 20_000;

async function* queueCsvLines(tenantId: string, scope: CaseScope): AsyncGenerator<string> {
  yield csvLine(["conversa", "contato", "telefone", "aguardando_ha_segundos", "ultima_mensagem_contato"]);
  let cursorAt: string | null = null;
  let cursorMid: string | null = null;
  let cursorCid: string | null = null;
  let emitted = 0;
  while (emitted < QUEUE_CSV_LIMIT) {
    const conditions = [
      "c.tenant_id=$1",
      "c.status='open'",
      "latest_message.sender='contact'",
      `(${conversationScopeCondition(scope, "c", "$2")})`
    ];
    const params: unknown[] = [tenantId, scope.userId];
    if (cursorAt && cursorMid && cursorCid) {
      params.push(cursorAt, cursorMid, cursorCid);
      conditions.push(`(latest_message.created_at,latest_message.id,c.id)<($${params.length - 2}::timestamptz,$${params.length - 1}::uuid,$${params.length}::uuid)`);
    }
    params.push(QUEUE_CSV_PAGE);
    const page = await db.query<{ id: string; contact_name: string | null; contact_phone: string; last_inbound_at: Date | null; last_message_at: Date; last_message_id: string }>(
      `SELECT c.id,c.contact_name,c.contact_phone,
              latest_contact.created_at last_inbound_at,
              latest_message.created_at last_message_at, latest_message.id last_message_id
       FROM conversations c
       LEFT JOIN LATERAL (
         SELECT message.sender,message.created_at,message.id FROM messages message
         WHERE message.conversation_id=c.id
         ORDER BY message.created_at DESC, message.id DESC LIMIT 1
       ) latest_message ON true
       LEFT JOIN LATERAL (
         SELECT m.created_at FROM messages m
         WHERE m.conversation_id=c.id AND m.sender='contact'
         ORDER BY m.created_at DESC, m.id DESC LIMIT 1
       ) latest_contact ON true
       WHERE ${conditions.join(" AND ")}
       ORDER BY latest_message.created_at DESC, latest_message.id DESC, c.id DESC
       LIMIT $${params.length}`,
      params
    );
    if (!page.rows.length) break;
    const now = Date.now();
    for (const row of page.rows) {
      if (emitted >= QUEUE_CSV_LIMIT) break;
      const waiting = row.last_inbound_at ? Math.max(0, Math.round((now - row.last_inbound_at.getTime()) / 1000)) : "";
      yield csvLine([row.id, row.contact_name ?? "", row.contact_phone, waiting, row.last_inbound_at?.toISOString() ?? ""]);
      emitted += 1;
    }
    const last = page.rows[page.rows.length - 1];
    cursorAt = last.last_message_at.toISOString();
    cursorMid = last.last_message_id;
    cursorCid = last.id;
    if (page.rows.length < QUEUE_CSV_PAGE) break;
  }
}

export type ReportCsvType = "volume" | "agents" | "status" | "quality";

export async function buildReportCsv(tenantId: string, scope: CaseScope, type: ReportCsvType, range: ReportRange): Promise<Readable> {
  if (type === "volume") {
    const { points } = await loadConversationVolume(tenantId, scope, range, await loadTenantTimezone(tenantId));
    const lines = [csvLine(["data", "total", "abertas", "fechadas", "aguardando_resposta"])];
    for (const point of points) lines.push(csvLine([point.date, point.total, point.open, point.closed, point.pending]));
    return Readable.from(lines.join(""));
  }
  if (type === "agents") {
    const { items } = await loadAgentProductivity(tenantId, scope, range);
    const lines = [csvLine(["operador", "email", "atendidas", "encerradas", "mensagens_enviadas"])];
    for (const item of items) lines.push(csvLine([item.name, item.email, item.answered, item.closed, item.messages_sent]));
    return Readable.from(lines.join(""));
  }
  if (type === "status") {
    const { items } = await loadStatusFlow(tenantId, scope, range);
    const lines = [csvLine(["status", "total", "media_fechamento_minutos"])];
    for (const item of items) lines.push(csvLine([item.status, item.total, item.avg_close_minutes ?? ""]));
    return Readable.from(lines.join(""));
  }
  const quality = await loadQualityReport(tenantId, scope, range);
  const lines: string[] = [];
  lines.push("fila_aguardando_resposta\n");
  lines.push(csvLine(["total", "media_espera_segundos"]));
  lines.push(csvLine([quality.queue.count, quality.queue.avg_wait_seconds ?? ""]));
  for await (const line of queueCsvLines(tenantId, scope)) lines.push(line);
  lines.push("\nprimeira_resposta_por_operador\n");
  lines.push(csvLine(["operador", "segundos"]));
  for (const item of quality.avg_first_response) lines.push(csvLine([item.name, item.seconds]));
  lines.push("\ngargalos_pipeline\n");
  lines.push(csvLine(["etapa", "contatos", "media_minutos"]));
  for (const item of quality.bottlenecks) lines.push(csvLine([item.stage_name, item.contacts, item.avg_minutes ?? ""]));
  lines.push("\noperadores_ociosos\n");
  lines.push(csvLine(["operador", "email"]));
  for (const item of quality.idle_agents) lines.push(csvLine([item.name, item.email]));
  return Readable.from(lines.join(""));
}
