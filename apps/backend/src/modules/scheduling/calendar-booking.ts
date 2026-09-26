import type { PoolClient } from "pg";
import { config } from "../../config.js";
import { decryptSecret } from "../ai-router/secret-box.js";
import { listAvailableAppointmentAttendants } from "../assignments/service.js";
import {
  GoogleCalendarApiError,
  GoogleCalendarConfigurationError,
  createGoogleCalendarClient,
  type GoogleCalendarBusyInterval,
  type GoogleCalendarClient
} from "./google-calendar.js";
import { httpError } from "./service.js";

// Rota da etapa do lead (specs/active/google-calendar-team-sync.md):
// conexão fixa → responsável é o dono da conexão; equipe → pool restrito aos
// membros da equipe; sem rota → mantém o responsável selecionado (comportamento atual).
export type PipelineCalendarRoute =
  | { kind: "team"; teamId: string }
  | { kind: "connection"; connectionId: string; ownerMemberId: string };

export async function loadPipelineCalendarRoute(
  client: PoolClient,
  tenantId: string,
  leadId: string
): Promise<PipelineCalendarRoute | null> {
  const result = await client.query<{ team_id: string | null; connection_id: string | null; owner_member_id: string | null }>(
    `SELECT route.team_id,route.connection_id,connection.member_id owner_member_id
     FROM scheduling_leads lead
     JOIN pipeline_stages stage ON stage.id=lead.pipeline_stage_id AND stage.tenant_id=lead.tenant_id
     LEFT JOIN scheduling_pipeline_calendar_routes route
       ON route.tenant_id=lead.tenant_id AND route.pipeline_id=stage.pipeline_id
     LEFT JOIN scheduling_calendar_connections connection
       ON connection.id=route.connection_id AND connection.tenant_id=route.tenant_id
     WHERE lead.id=$1 AND lead.tenant_id=$2`,
    [leadId, tenantId]
  );
  const row = result.rows[0];
  if (row?.connection_id && row.owner_member_id) {
    return { kind: "connection", connectionId: row.connection_id, ownerMemberId: row.owner_member_id };
  }
  if (row?.team_id) return { kind: "team", teamId: row.team_id };
  return null;
}

/** Atendentes elegíveis do pool FORA da equipe da rota (exclusão na rotação). */
export async function routeTeamExclusionIds(client: PoolClient, tenantId: string, teamId: string): Promise<string[]> {
  const pool = await listAvailableAppointmentAttendants(client, tenantId);
  if (!pool.length) return [];
  const team = await client.query<{ member_id: string }>(
    `SELECT id member_id FROM workspace_members
     WHERE workspace_id=$1 AND team_id=$2 AND id=ANY($3::uuid[])`,
    [tenantId, teamId, pool.map((attendant) => attendant.memberId)]
  );
  const inTeam = new Set(team.rows.map((row) => row.member_id));
  return pool.filter((attendant) => !inTeam.has(attendant.memberId)).map((attendant) => attendant.memberId);
}

/** Equipe da rota exige atendente da própria equipe. */
export async function assertPipelineRouteTeam(
  client: PoolClient,
  tenantId: string,
  route: PipelineCalendarRoute | null,
  memberId: string
): Promise<void> {
  if (route?.kind !== "team") return;
  const member = await client.query(
    "SELECT 1 FROM workspace_members WHERE workspace_id=$1 AND id=$2 AND team_id=$3",
    [tenantId, memberId, route.teamId]
  );
  if (!member.rows[0]) throw httpError(409, "A rota da etapa exige responsável da equipe configurada");
}

export type CalendarBookingClient = Pick<GoogleCalendarClient, "freeBusy" | "listEvents">;

// Test seam: suítes de integração trocam o client (HTTP do Google stubado) sem
// tocar em service.ts. Nenhum caminho de produção alterna a fábrica.
let calendarBookingClientFactory: () => CalendarBookingClient = createGoogleCalendarClient;

export function setCalendarBookingClientFactory(factory: (() => CalendarBookingClient) | null): void {
  calendarBookingClientFactory = factory ?? createGoogleCalendarClient;
}

type BookingConnectionRow = {
  id: string;
  calendar_id: string;
  buffer_minutes: number;
  refresh_token_encrypted: string;
};

async function loadBookingConnection(client: PoolClient, tenantId: string, memberId: string): Promise<BookingConnectionRow | null> {
  const connections = await client.query<BookingConnectionRow>(
    `SELECT id,calendar_id,buffer_minutes,refresh_token_encrypted
     FROM scheduling_calendar_connections
     WHERE tenant_id=$1 AND member_id=$2`,
    [tenantId, memberId]
  );
  return connections.rows[0] ?? null;
}

// Keyring {current, previous} (mesmo contrato do calendar-sync): durante a
// rotação planejada, tokens cifrados com a chave anterior continuam legíveis.
function connectionRefreshToken(connection: BookingConnectionRow): string {
  return decryptSecret(connection.refresh_token_encrypted, {
    current: config.DATA_ENCRYPTION_KEY,
    previous: config.DATA_ENCRYPTION_KEY_PREVIOUS ? [config.DATA_ENCRYPTION_KEY_PREVIOUS] : []
  });
}

/**
 * Checagem fail-closed de disponibilidade do Google Calendar ANTES do commit
 * (spec: se o Google estiver indisponível, não confirmar o horário como livre).
 * Sem conexão do responsável ou sem agenda selecionada → lógica legada (no-op).
 */
export async function assertGoogleCalendarAvailability(
  client: PoolClient,
  tenantId: string,
  memberId: string | null,
  interval: { start: Date; end: Date },
  options: { excludeAppointmentId?: string } = {}
): Promise<void> {
  if (!memberId) return;
  const connection = await loadBookingConnection(client, tenantId, memberId);
  if (!connection || !connection.calendar_id) return;

  // Janela inclui o buffer da agenda (0186): compromissos na folga antes/depois
  // do slot também bloqueiam. A consulta é instantânea (ISO); timezone da agenda
  // é do Google — duração/intervalo já vieram das validações existentes.
  const bufferMs = Math.max(0, Math.min(240, connection.buffer_minutes)) * 60_000;
  const windowStart = interval.start.getTime() - bufferMs;
  const windowEnd = interval.end.getTime() + bufferMs;
  const refreshToken = connectionRefreshToken(connection);
  const calendarClient = calendarBookingClientFactory();

  // Evento próprio vinculado (reagendamento/reatribuição): freeBusy mescla eventos
  // coincidentes em um único bloco, então igualdade de intervalo não identifica o
  // nosso — um evento externo coincidente ficaria invisível e o slot ocupado seria
  // aprovado. Falha fechada: excusa SOMENTE o evento vinculado, por IDENTITY via
  // lista de eventos; qualquer outro evento sobreposto à janela conflita.
  const linkedEventId = options.excludeAppointmentId
    ? await linkedCalendarEventId(client, {
        tenantId,
        appointmentId: options.excludeAppointmentId,
        connectionId: connection.id,
        calendarId: connection.calendar_id
      })
    : null;

  let conflicts: boolean;
  try {
    if (linkedEventId) {
      const events = await calendarClient.listEvents(
        refreshToken,
        connection.calendar_id,
        new Date(windowStart).toISOString(),
        new Date(windowEnd).toISOString()
      );
      conflicts = events.some((event) => {
        // Nosso evento vinculado: excusado por identidade (nunca só por intervalo).
        if (event.id === linkedEventId) return false;
        if (event.transparency === "transparent") return false;
        const startMs = Date.parse(event.start?.dateTime ?? event.start?.date ?? "");
        const endMs = Date.parse(event.end?.dateTime ?? event.end?.date ?? "");
        // Entrada indecifrável → fail-closed: sem confirmação de horário livre.
        if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs <= startMs) return true;
        return startMs < windowEnd && endMs > windowStart;
      });
    } else {
      const busy = await calendarClient.freeBusy(
        refreshToken,
        connection.calendar_id,
        new Date(windowStart).toISOString(),
        new Date(windowEnd).toISOString()
      );
      conflicts = busy.some((entry) => {
        const busyStart = Date.parse(entry.start);
        const busyEnd = Date.parse(entry.end);
        // Entrada indecifrável → fail-closed: sem confirmação de horário livre.
        if (Number.isNaN(busyStart) || Number.isNaN(busyEnd) || busyEnd <= busyStart) return true;
        return busyStart < windowEnd && busyEnd > windowStart;
      });
    }
  } catch (error) {
    if (error instanceof GoogleCalendarApiError || error instanceof GoogleCalendarConfigurationError) throw error;
    throw new GoogleCalendarApiError("Não foi possível consultar a disponibilidade no Google Calendar");
  }
  if (conflicts) throw httpError(409, "O horário conflita com um compromisso no Google Calendar do responsável");
}

/**
 * Intervalos ocupados do Google Calendar do responsável, JÁ expandidos pelo
 * buffer da agenda (0186), para compor a grade de horários (verificarHorarios).
 * Uma única chamada freeBusy sobre o dia expandido (expandir os intervalos pelo
 * buffer é equivalente a expandir a janela de consulta). Sem conexão do
 * responsável ou sem agenda selecionada → [] (lógica legada). Falha fechada:
 * Google indisponível ou entrada malformada → erro (502 na rota), nunca grade
 * "livre" sem confirmação.
 */
export async function listGoogleCalendarBusyIntervals(
  client: PoolClient,
  tenantId: string,
  memberId: string,
  interval: { start: Date; end: Date }
): Promise<Array<{ start_at: Date; end_at: Date }>> {
  const connection = await loadBookingConnection(client, tenantId, memberId);
  if (!connection || !connection.calendar_id) return [];
  const bufferMs = Math.max(0, Math.min(240, connection.buffer_minutes)) * 60_000;
  const refreshToken = connectionRefreshToken(connection);
  let busy: GoogleCalendarBusyInterval[];
  try {
    busy = await calendarBookingClientFactory().freeBusy(
      refreshToken,
      connection.calendar_id,
      new Date(interval.start.getTime() - bufferMs).toISOString(),
      new Date(interval.end.getTime() + bufferMs).toISOString()
    );
  } catch (error) {
    if (error instanceof GoogleCalendarApiError || error instanceof GoogleCalendarConfigurationError) throw error;
    throw new GoogleCalendarApiError("Não foi possível consultar a disponibilidade no Google Calendar");
  }
  return busy.map((entry) => {
    const startMs = Date.parse(entry.start);
    const endMs = Date.parse(entry.end);
    // Entrada malformada → falha fechada (mesma regra do assert de booking).
    if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs <= startMs) {
      throw new GoogleCalendarApiError("O Google retornou uma resposta de disponibilidade inválida");
    }
    return { start_at: new Date(startMs - bufferMs), end_at: new Date(endMs + bufferMs) };
  });
}

async function linkedCalendarEventId(
  client: PoolClient,
  keys: { tenantId: string; appointmentId: string; connectionId: string; calendarId: string }
): Promise<string | null> {
  const linked = await client.query<{ event_id: string }>(
    `SELECT event_id FROM scheduling_appointment_calendar_events
     WHERE appointment_id=$1 AND tenant_id=$2 AND connection_id=$3 AND calendar_id=$4
     LIMIT 1`,
    [keys.appointmentId, keys.tenantId, keys.connectionId, keys.calendarId]
  );
  return linked.rows[0]?.event_id ?? null;
}
