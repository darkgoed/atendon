import type { Pool, PoolClient } from "pg";
import { config } from "../../config.js";
import { logger } from "../../logger.js";
import { decryptSecret, type SecretKeyring } from "../ai-router/secret-box.js";
import { db } from "../../db/client.js";
import {
  GoogleCalendarApiError,
  GoogleCalendarClient,
  atendonCalendarEventId,
  createGoogleCalendarClient,
  type GoogleCalendarEvent,
  type GoogleCalendarEventFields
} from "./google-calendar.js";
import { adoptGoogleCalendarChange } from "./calendar-inbound.js";
import type { AppointmentStatus } from "./service.js";

const DEFAULT_LEASE_MS = 120_000;
const DEFAULT_MAX_ATTEMPTS = 12;
const OUTBOX_BATCH_LIMIT = 20;
const LINKS_POLL_LIMIT = 20;
const LINKS_STALE_MS = 5 * 60_000;
const LINKS_INTERVAL_MS = 5 * 60_000;

export type CalendarSyncKind = "upsert" | "delete";
export type CalendarSyncJob = {
  tenantId: string;
  appointmentId: string;
  kind: CalendarSyncKind;
  attempts: number;
  claimToken: string;
};

type WorkRow = {
  appointment_id: string;
  tenant_id: string;
  start_at: Date;
  end_at: Date;
  status: string;
  assigned_member_id: string | null;
  meeting_url: string | null;
  meeting_provider: string | null;
  meeting_provisioning_status: string | null;
  observation: string | null;
  lead_name: string | null;
  lead_phone: string | null;
  lead_deleted: boolean;
  unit_name: string;
  outbox_kind: string;
  route_connection_id: string | null;
  route_target_connection_id: string | null;
  route_target_calendar_id: string | null;
  route_target_calendar_timezone: string | null;
  route_target_refresh_token_encrypted: string | null;
  member_target_connection_id: string | null;
  member_target_calendar_id: string | null;
  member_target_calendar_timezone: string | null;
  member_target_refresh_token_encrypted: string | null;
  link_connection_id: string | null;
  link_calendar_id: string | null;
  link_event_id: string | null;
  link_etag: string | null;
  link_refresh_token_encrypted: string | null;
};

export type CalendarSyncWork = {
  job: CalendarSyncJob;
  fields: GoogleCalendarEventFields;
  link: {
    connectionId: string | null;
    calendarId: string;
    eventId: string;
    etag: string | null;
    refreshTokenEncrypted: string | null;
  } | null;
  target: {
    connectionId: string;
    calendarId: string;
    refreshTokenEncrypted: string;
    calendarTimezone: string | null;
  } | null;
  // Rota explícita de pipeline aponta para uma conexão cujo calendar_id é NULL
  // (reconexão limpa a seleção): destino indefinido, nunca o assignee.
  routeUnconfigured: boolean;
  eventId: string;
  snapshot: string;
};

// Erro opaco: só a mensagem (nossa, pt-BR, sem tokens) entra em last_error/DB.
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 2_000) : String(error).slice(0, 2_000);
}

// Só o horário é protegido contra escrita cega (spec: nunca recriar/mover
// evento que o usuário editou); título/descrição são conteúdo do AtendON.
function eventTimesMatch(event: { start?: unknown; end?: unknown }, fields: GoogleCalendarEventFields): boolean {
  const googleStart = (event.start as { dateTime?: string } | undefined)?.dateTime;
  const googleEnd = (event.end as { dateTime?: string } | undefined)?.dateTime;
  const oursStart = Date.parse(fields.start.dateTime);
  const oursEnd = Date.parse(fields.end.dateTime);
  const googleStartTime = googleStart ? Date.parse(googleStart) : Number.NaN;
  const googleEndTime = googleEnd ? Date.parse(googleEnd) : Number.NaN;
  return googleStartTime === oursStart && googleEndTime === oursEnd;
}

// Snapshot do estado que determina o evento remoto. O worker compara antes de
// drenar a linha do outbox: mutação durante a chamada ao Google → release.
function snapshotOf(row: {
  start_at: Date; end_at: Date; status: string; assigned_member_id: string | null;
  meeting_url: string | null; meeting_provider: string | null; meeting_provisioning_status: string | null;
  observation: string | null; lead_name: string | null; lead_deleted: boolean; unit_name: string;
  route_target_connection_id: string | null; route_target_calendar_id: string | null;
  member_target_connection_id: string | null; member_target_calendar_id: string | null; outbox_kind: string;
}): string {
  return JSON.stringify({
    start: row.start_at.toISOString(),
    end: row.end_at.toISOString(),
    status: row.status,
    assigned: row.assigned_member_id,
    meetingUrl: row.meeting_url,
    provider: row.meeting_provider,
    provisioning: row.meeting_provisioning_status,
    observation: row.observation,
    leadName: row.lead_name,
    leadDeleted: row.lead_deleted,
    unitName: row.unit_name,
    targetConnection: row.route_target_connection_id,
    targetCalendar: row.route_target_calendar_id,
    memberTargetConnection: row.member_target_connection_id,
    memberTargetCalendar: row.member_target_calendar_id,
    kind: row.outbox_kind
  });
}

const WORK_SELECT = `
  SELECT a.id appointment_id,a.tenant_id,a.start_at,a.end_at,a.status,a.assigned_member_id,
         a.meeting_url,a.meeting_provider,a.meeting_provisioning_status,a.observation,
         lead.name lead_name,lead.phone lead_phone,lead.deleted_at IS NOT NULL lead_deleted,
         unit.name unit_name,
         outbox.kind outbox_kind,
         route.connection_id route_connection_id,
         route_target.id route_target_connection_id,route_target.calendar_id route_target_calendar_id,
         route_target.calendar_timezone route_target_calendar_timezone,
         route_target.refresh_token_encrypted route_target_refresh_token_encrypted,
         member_target.id member_target_connection_id,member_target.calendar_id member_target_calendar_id,
         member_target.calendar_timezone member_target_calendar_timezone,
         member_target.refresh_token_encrypted member_target_refresh_token_encrypted,
         link.connection_id link_connection_id,link.calendar_id link_calendar_id,
         link.event_id link_event_id,link.etag link_etag,
         linkconn.refresh_token_encrypted link_refresh_token_encrypted
  FROM scheduling_calendar_sync_outbox outbox
  JOIN scheduling_appointments a
    ON a.id=outbox.appointment_id AND a.tenant_id=outbox.tenant_id
  JOIN scheduling_units unit
    ON unit.tenant_id=a.tenant_id AND unit.id=a.unit_id
  JOIN tenants tenant ON tenant.id=a.tenant_id
  JOIN scheduling_leads lead
    ON lead.id=a.lead_id AND lead.tenant_id=a.tenant_id
  LEFT JOIN pipeline_stages stage
    ON stage.id=lead.pipeline_stage_id AND stage.tenant_id=a.tenant_id
  LEFT JOIN scheduling_pipeline_calendar_routes route
    ON route.tenant_id=a.tenant_id AND route.pipeline_id=stage.pipeline_id
  LEFT JOIN LATERAL (
    SELECT c.* FROM scheduling_calendar_connections c
    WHERE c.tenant_id=a.tenant_id AND c.id=route.connection_id AND c.calendar_id IS NOT NULL
    LIMIT 1
  ) route_target ON TRUE
  LEFT JOIN LATERAL (
    SELECT c.* FROM scheduling_calendar_connections c
    WHERE c.tenant_id=a.tenant_id AND c.member_id=a.assigned_member_id AND c.calendar_id IS NOT NULL
    LIMIT 1
  ) member_target ON TRUE
  LEFT JOIN scheduling_appointment_calendar_events link
    ON link.appointment_id=outbox.appointment_id AND link.tenant_id=outbox.tenant_id
  LEFT JOIN scheduling_calendar_connections linkconn
    ON linkconn.id=link.connection_id AND linkconn.tenant_id=link.tenant_id
  WHERE outbox.appointment_id=$1 AND outbox.tenant_id=$2`;

// Destino do evento: rota explícita de conexão primeiro; sem rota (ou rota de
// equipe) → conexão do assignee do AtendON, se houver agenda selecionada.
function resolveTarget(row: WorkRow): CalendarSyncWork["target"] {
  // Rota explícita de conexão sem agenda selecionada: NUNCA cair para a conexão
  // do assignee — o evento iria para o calendário de terceiro. O worker marca
  // falha observável (routeUnconfigured) em vez de rotear.
  if (row.route_connection_id && !row.route_target_connection_id) return null;
  const connectionId = row.route_target_connection_id ?? row.member_target_connection_id;
  const calendarId = row.route_target_connection_id
    ? row.route_target_calendar_id
    : row.member_target_calendar_id;
  const refreshTokenEncrypted = row.route_target_connection_id
    ? row.route_target_refresh_token_encrypted
    : row.member_target_refresh_token_encrypted;
  if (!connectionId || !calendarId || !refreshTokenEncrypted) return null;
  return {
    connectionId,
    calendarId,
    refreshTokenEncrypted,
    calendarTimezone: (row.route_target_connection_id
      ? row.route_target_calendar_timezone
      : row.member_target_calendar_timezone) ?? null
  };
}

function buildWork(row: WorkRow | null, job: CalendarSyncJob): CalendarSyncWork | null {
  if (!row) return null;
  const fields: GoogleCalendarEventFields = {
    summary: (row.lead_name ?? "Reunião AtendON").slice(0, 500),
    description: [
      row.unit_name ? `Unidade: ${row.unit_name}` : null,
      row.observation?.slice(0, 2_000) ?? null,
      row.meeting_url ? `Reunião online: ${row.meeting_url}` : null,
      `Contato: ${row.lead_phone ?? "?"}`
    ].filter((part): part is string => Boolean(part)).join("\n"),
    location: row.unit_name || undefined,
    start: { dateTime: row.start_at.toISOString() },
    end: { dateTime: row.end_at.toISOString() },
    extendedProperties: { private: {
      atendon_appointment_id: row.appointment_id,
      atendon_tenant_id: row.tenant_id
    } }
  };
  // Sem conferenceData.createRequest: o sync nunca pede Meet ao Google. Quando
  // há reunião (AtendON Meet ou Google Meet legado), o meeting_url provisionado
  // já vai na descrição acima; criar conference aqui gerava link órfão que o
  // AtendON não conhece — e Meet criado mesmo com os dois Meet desligados.
  const link = row.link_event_id && row.link_calendar_id
    ? {
        connectionId: row.link_connection_id,
        calendarId: row.link_calendar_id,
        eventId: row.link_event_id,
        etag: row.link_etag,
        refreshTokenEncrypted: row.link_refresh_token_encrypted
      }
    : null;
  return {
    job,
    fields,
    link,
    target: resolveTarget(row),
    routeUnconfigured: Boolean(row.route_connection_id) && !row.route_target_connection_id,
    eventId: atendonCalendarEventId(row.appointment_id),
    snapshot: snapshotOf(row)
  };
}

export class CalendarSyncRepository {
  constructor(
    private readonly pool: Pool = db,
    private readonly leaseMs = DEFAULT_LEASE_MS,
    private readonly maxAttempts = DEFAULT_MAX_ATTEMPTS
  ) {}

  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  // Reivindica um lote: SKIP LOCKED garante 1 claim por agendamento entre
  // processos; lease cobre worker morto no meio da chamada. O token de posse
  // garante que só o dono atual conclui (lease vencido → outro worker pode
  // ter reclamado de novo: complete obsoleto não grava por cima). Backoff é
  // o available_at: sem o filtro, linha em retry seria reclamada a cada tick.
  async claimDue(limit = OUTBOX_BATCH_LIMIT): Promise<CalendarSyncJob[]> {
    return this.transaction(async (client) => {
      const rows = await client.query<{
        appointment_id: string; tenant_id: string; kind: string; attempts: number; claim_token: string;
      }>(
        `UPDATE scheduling_calendar_sync_outbox outbox
         SET claimed_at=now(),claim_token=gen_random_uuid(),attempts=outbox.attempts+1
         FROM (
           SELECT appointment_id,tenant_id
           FROM scheduling_calendar_sync_outbox
           WHERE available_at <= now()
             AND (claimed_at IS NULL
                  OR claimed_at <= now() - ($2::bigint * interval '1 millisecond'))
           ORDER BY available_at,appointment_id
           LIMIT $1
           FOR UPDATE SKIP LOCKED
         ) due
         WHERE outbox.appointment_id=due.appointment_id
           AND outbox.tenant_id=due.tenant_id
         RETURNING outbox.appointment_id,outbox.tenant_id,outbox.kind,outbox.attempts,outbox.claim_token`,
        [limit, this.leaseMs]
      );
      return rows.rows.map((row) => ({
        tenantId: row.tenant_id,
        appointmentId: row.appointment_id,
        kind: row.kind === "delete" ? "delete" : "upsert",
        attempts: row.attempts,
        claimToken: row.claim_token
      }));
    });
  }

  async loadWork(job: CalendarSyncJob): Promise<CalendarSyncWork | null> {
    const rows = await this.pool.query<WorkRow>(WORK_SELECT, [job.appointmentId, job.tenantId]);
    return buildWork(rows.rows[0] ?? null, job);
  }

  // Drena um trabalho sem destino nem vínculo: sem isso a linha era
  // 'dropped' mas ficava na outbox e o pump a reclamava para sempre
  // (loop quente). Guardado pelo token de posse.
  // ponytail: mutação de outbox concorrente nesse intervalo não é refeita
  // automaticamente — a próxima mutação de agendamento re-enfileira.
  async drain(job: CalendarSyncJob): Promise<void> {
    await this.pool.query(
      `DELETE FROM scheduling_calendar_sync_outbox
       WHERE appointment_id=$1 AND tenant_id=$2 AND claim_token IS NOT DISTINCT FROM $3`,
      [job.appointmentId, job.tenantId, job.claimToken]
    );
  }

  // Conclui uma tentativa BEM-SUCEDIDA. Antes de drenar a linha, compara o
  // snapshot atual com o do início da chamada: mudou (mutação concorrente,
  // cancelamento, rotação) → re-libera a linha em vez de perder a mutação.
  async complete(
    work: CalendarSyncWork,
    result: { etag?: string | null; conflict?: string }
  ): Promise<"synced" | "raced" | "dropped" | "stale" | "conflict"> {
    return this.transaction(async (client) => {
      // Posse do claim: linha drenada por outra passada → nada a fazer (dropped);
      // token diferente → claim venceu e outro worker assumiu (stale): não
      // gravar por cima (o dono atual escreverá o resultado dele).
      const owned = (await client.query<{ claim_token: string | null }>(
        `SELECT claim_token FROM scheduling_calendar_sync_outbox
         WHERE appointment_id=$1 AND tenant_id=$2
         FOR UPDATE`,
        [work.job.appointmentId, work.job.tenantId]
      )).rows[0];
      if (!owned) return "dropped";
      if (owned.claim_token !== work.job.claimToken) return "stale";
      const current = (await client.query<WorkRow>(
        WORK_SELECT,
        [work.job.appointmentId, work.job.tenantId]
      )).rows[0] ?? null;
      if (!current) {
        // JOIN quebrado (lead/unidade sumidos): drena a linha órfã do outbox.
        await client.query(
          `DELETE FROM scheduling_calendar_sync_outbox
           WHERE appointment_id=$1 AND tenant_id=$2`,
          [work.job.appointmentId, work.job.tenantId]
        );
        return "dropped"; // agendamento removido: nada a sincronizar
      }
      if (snapshotOf(current) !== work.snapshot) {
        await client.query(
          `UPDATE scheduling_calendar_sync_outbox
           SET claimed_at=NULL,claim_token=NULL,available_at=now()
           WHERE appointment_id=$1 AND tenant_id=$2`,
          [work.job.appointmentId, work.job.tenantId]
        );
        return "raced";
      }
      let outcome: "synced" | "conflict" = "synced";
      if (result.conflict) {
        await client.query(
          `UPDATE scheduling_appointment_calendar_events
           SET sync_error=$3,last_synced_at=now()
           WHERE appointment_id=$1 AND tenant_id=$2`,
          [work.job.appointmentId, work.job.tenantId, result.conflict]
        );
        outcome = "conflict";
      } else if (work.job.kind === "upsert") {
        await client.query(
          `INSERT INTO scheduling_appointment_calendar_events(
             appointment_id,tenant_id,connection_id,calendar_id,event_id,etag,last_synced_at,sync_error)
           VALUES($1,$2,$3,$4,$5,$6,now(),NULL)
           ON CONFLICT (appointment_id) DO UPDATE SET
             connection_id=EXCLUDED.connection_id,
             calendar_id=EXCLUDED.calendar_id,
             event_id=EXCLUDED.event_id,
             etag=EXCLUDED.etag,
             last_synced_at=now(),
             sync_error=NULL`,
          [work.job.appointmentId, work.job.tenantId, work.target!.connectionId,
           work.target!.calendarId, work.eventId, result.etag ?? null]
        );
      } else {
        // delete confirmado remotamente (200/404/410): agora sim apaga o vínculo.
        await client.query(
          `DELETE FROM scheduling_appointment_calendar_events
           WHERE appointment_id=$1 AND tenant_id=$2`,
          [work.job.appointmentId, work.job.tenantId]
        );
      }
      await client.query(
        `DELETE FROM scheduling_calendar_sync_outbox
         WHERE appointment_id=$1 AND tenant_id=$2`,
        [work.job.appointmentId, work.job.tenantId]
      );
      return outcome;
    });
  }

  // Falha: solta o claim com backoff exponencial (cap 60min; após o teto de
  // tentativas, 6h — linha observável via attempts/last_error, nunca perdida).
  // Só o dono do claim registra a falha.
  async recordFailure(work: CalendarSyncWork, error: unknown): Promise<void> {
    const message = errorMessage(error);
    const attempts = work.job.attempts;
    const backoffMs = attempts >= this.maxAttempts
      ? 6 * 60 * 60_000
      : Math.min(60 * 60_000, 30_000 * 2 ** Math.max(0, attempts - 1));
    await this.transaction(async (client) => {
      await client.query(
        `UPDATE scheduling_calendar_sync_outbox
         SET claimed_at=NULL,
             claim_token=NULL,
             available_at=now() + ($3::bigint * interval '1 millisecond'),
             last_error=$2
         WHERE appointment_id=$1 AND tenant_id=$4 AND claim_token IS NOT DISTINCT FROM $5`,
        [work.job.appointmentId, message, backoffMs, work.job.tenantId, work.job.claimToken]
      );
      // Erro visível também no vínculo (painel), para upserts que já tinham link.
      if (work.job.kind === "upsert" && work.link) {
        await client.query(
          `UPDATE scheduling_appointment_calendar_events
           SET sync_error=$3
           WHERE appointment_id=$1 AND tenant_id=$2`,
          [work.job.appointmentId, work.job.tenantId, message]
        );
      }
    });
  }

  // Reconciliação de eventos vinculados: claim por last_synced_at; o stamp
  // devolvido é o marcador de claim da escrita posterior.
  async claimStaleLinked(limit = LINKS_POLL_LIMIT, staleMs = LINKS_STALE_MS): Promise<Array<{
    tenantId: string; appointmentId: string; connectionId: string; calendarId: string; eventId: string;
    etag: string | null; syncError: string | null; refreshTokenEncrypted: string;
    startAt: Date; endAt: Date; status: string; claimedAt: Date;
  }>> {
    return this.transaction(async (client) => {
      const due = await client.query<{
        appointment_id: string; tenant_id: string;
      }>(
        `SELECT e.appointment_id,e.tenant_id
         FROM scheduling_appointment_calendar_events e
         JOIN scheduling_appointments a
           ON a.id=e.appointment_id AND a.tenant_id=e.tenant_id
         JOIN scheduling_calendar_connections c
           ON c.id=e.connection_id AND c.tenant_id=e.tenant_id AND c.calendar_id IS NOT NULL
         WHERE a.start_at > now()
           AND a.status IN ('confirmado','reagendado')
           AND (e.last_synced_at IS NULL
                OR e.last_synced_at <= now() - ($2::bigint * interval '1 millisecond'))
         ORDER BY e.appointment_id
         LIMIT $1
         FOR UPDATE OF e SKIP LOCKED`,
        [limit, staleMs]
      );
      const claimed: Array<{
        tenantId: string; appointmentId: string; connectionId: string; calendarId: string; eventId: string;
        etag: string | null; syncError: string | null; refreshTokenEncrypted: string;
        startAt: Date; endAt: Date; status: string; claimedAt: Date;
      }> = [];
      for (const row of due.rows) {
        const stamped = (await client.query<{
          connection_id: string; calendar_id: string; event_id: string; etag: string | null; sync_error: string | null;
          refresh_token_encrypted: string; start_at: Date; end_at: Date; status: string; claimed_at: Date;
        }>(
          `UPDATE scheduling_appointment_calendar_events e
           SET last_synced_at=date_trunc('millisecond', now())
           FROM scheduling_appointments a, scheduling_calendar_connections c
           WHERE e.appointment_id=$1 AND e.tenant_id=$2
             AND a.id=e.appointment_id AND a.tenant_id=e.tenant_id
             AND c.id=e.connection_id AND c.tenant_id=e.tenant_id
           RETURNING e.connection_id,e.calendar_id,e.event_id,e.etag,e.sync_error,
                     c.refresh_token_encrypted,a.start_at,a.end_at,a.status,e.last_synced_at claimed_at`,
          [row.appointment_id, row.tenant_id]
        )).rows[0];
        if (!stamped) continue;
        claimed.push({
          tenantId: row.tenant_id,
          appointmentId: row.appointment_id,
          connectionId: stamped.connection_id,
          calendarId: stamped.calendar_id,
          eventId: stamped.event_id,
          etag: stamped.etag,
          syncError: stamped.sync_error,
          refreshTokenEncrypted: stamped.refresh_token_encrypted,
          startAt: stamped.start_at,
          endAt: stamped.end_at,
          status: stamped.status,
          claimedAt: stamped.claimed_at
        });
      }
      return claimed;
    });
  }

  // Escrita do resultado da reconciliação, protegida pelo stamp do claim:
  // se o worker sincronizou no meio, o stamp mudou e esta escrita é descartada.
  async applyReconciliation(
    link: { tenantId: string; appointmentId: string },
    claimedAt: Date,
    result: { etag?: string | null; conflict?: string }
  ): Promise<void> {
    await this.transaction(async (client) => {
      if (result.conflict) {
        const previousError = (await client.query<{ previous: string | null }>(
          `SELECT sync_error previous FROM scheduling_appointment_calendar_events
           WHERE appointment_id=$1 AND tenant_id=$2 AND last_synced_at=$3
           FOR UPDATE`,
          [link.appointmentId, link.tenantId, claimedAt]
        )).rows[0]?.previous ?? null;
        const updated = await client.query(
          `UPDATE scheduling_appointment_calendar_events
           SET sync_error=$4,last_synced_at=now()
           WHERE appointment_id=$1 AND tenant_id=$2 AND last_synced_at=$3`,
          [link.appointmentId, link.tenantId, claimedAt, result.conflict]
        );
        // Alerta só na primeira vez que o conflito aparece (sem spam por ciclo).
        if (updated.rowCount && previousError === null) {
          await client.query(
            `INSERT INTO system_alerts(tenant_id,message,kind,audience,metadata)
             VALUES($1,$2,'operational','workspace',$3)`,
            [
              link.tenantId,
              "O evento vinculado no Google Calendar mudou no Google e diverge do agendamento. Reconcilie manualmente.",
              {
                event: "calendar_event_conflict",
                appointment_id: link.appointmentId,
                conflict: result.conflict
              }
            ]
          );
        }
        return;
      }
      await client.query(
        `UPDATE scheduling_appointment_calendar_events
         SET etag=COALESCE($4,etag),last_synced_at=now(),sync_error=NULL
         WHERE appointment_id=$1 AND tenant_id=$2 AND last_synced_at=$3`,
        [link.appointmentId, link.tenantId, claimedAt, result.etag ?? null]
      );
    });
  }
}

// ponytail: cache de client por conexão (evita refresh de token por job);
// estourou 500 conexões → limpa tudo (tokens voltam a ser renovados).
export class CalendarSyncProcessor {
  private readonly clients = new Map<string, GoogleCalendarClient>();
  private readonly keyring: SecretKeyring;

  constructor(
    private readonly repository: CalendarSyncRepository,
    private readonly createClient: () => GoogleCalendarClient = createGoogleCalendarClient,
    cfg: {
      DATA_ENCRYPTION_KEY: string;
      DATA_ENCRYPTION_KEY_PREVIOUS?: string;
    } = config
  ) {
    this.keyring = {
      current: cfg.DATA_ENCRYPTION_KEY,
      previous: cfg.DATA_ENCRYPTION_KEY_PREVIOUS ? [cfg.DATA_ENCRYPTION_KEY_PREVIOUS] : []
    };
  }

  client(connectionId: string): GoogleCalendarClient {
    let client = this.clients.get(connectionId);
    if (!client) {
      client = this.createClient();
      if (this.clients.size >= 500) this.clients.clear();
      this.clients.set(connectionId, client);
    }
    return client;
  }

  private refreshToken(refreshTokenEncrypted: string): string {
    return decryptSecret(refreshTokenEncrypted, this.keyring);
  }

  // Token de leitura para a reconciliação de vínculos (mesma keyring do sync).
  readLinkedToken(refreshTokenEncrypted: string): string {
    return this.refreshToken(refreshTokenEncrypted);
  }

  private isApiError(error: unknown): error is GoogleCalendarApiError {
    return error instanceof GoogleCalendarApiError;
  }

  async process(job: CalendarSyncJob): Promise<"synced" | "raced" | "dropped" | "stale" | "pending" | "conflict"> {
    const work = await this.repository.loadWork(job);
    if (!work) {
      // JOIN quebrado e linha presa na outbox: sem drenar, o pump reclamava
      // a mesma linha para sempre (loop quente).
      await this.repository.drain(job);
      return "dropped";
    }

    if (work.job.kind === "delete") {
      if (!work.link) {
        // Nada remoto a apagar: drena a linha (sem isso, loop quente).
        await this.repository.drain(job);
        return "dropped";
      }
      if (!work.link.connectionId || !work.link.refreshTokenEncrypted) {
        // Credencial indisponível (desconectada): vínculo vira histórico órfão.
        return await this.repository.complete(work, { conflict: "vínculo órfão: exclusão remota indisponível" });
      }
      try {
        await this.client(work.link.connectionId)
          .deleteEvent(this.refreshToken(work.link.refreshTokenEncrypted), work.link.calendarId, work.link.eventId);
      } catch (error) {
        await this.repository.recordFailure(work, error);
        return "pending";
      }
      await this.repository.complete(work, {});
      return "synced";
    }

    if (!work.target) {
      if (work.routeUnconfigured) {
        // Rota explícita quebrada (conexão reconectada sem agenda): NÃO roteia
        // para o assignee (calendário de terceiro) nem drena em silêncio —
        // falha observável (last_error/sync_error) com backoff; quando a agenda
        // é reselecionada (ou a rota muda), o retry converge.
        await this.repository.recordFailure(
          work,
          new Error("rota do pipeline aponta para conexão sem agenda selecionada")
        );
        return "pending";
      }
      if (!work.link) {
        // Nunca existiu evento remoto nem destino: drena a linha (sem isso,
        // o pump reclamava a mesma linha para sempre).
        await this.repository.drain(job);
        return "dropped";
      }
      await this.repository.complete(work, { conflict: "sem conexão com agenda selecionada" });
      return "conflict";
    }

    const rotated = Boolean(work.link
      && (work.link.connectionId !== work.target.connectionId
        || work.link.calendarId !== work.target.calendarId));
    if (rotated && work.link) {
      // Rotação de conta/agenda: o novo evento só nasce DEPOIS da exclusão
      // confirmada do antigo (200/404/410; deleteEvent trata 404/410 como
      // exclusão idempotente). Qualquer falha preserva vínculo antigo e outbox
      // (recordFailure: retry com backoff, erro visível em last_error/sync_error)
      // — inclusive a recusa definitiva ('failed', ex.: permissão perdida na
      // agenda antiga): duplicata nunca; o retry converge quando o Google volta
      // a aceitar, e a próxima mutação do agendamento re-enfileira se drenada.
      if (!work.link.connectionId || !work.link.refreshTokenEncrypted) {
        // Credencial indisponível (desconectada): exclusão remota impossível —
        // conflito terminal observável, sem criar o novo (mesmo padrão do delete).
        return await this.repository.complete(work, { conflict: "vínculo órfão: exclusão remota indisponível" });
      }
      try {
        await this.client(work.link.connectionId)
          .deleteEvent(
            this.refreshToken(work.link.refreshTokenEncrypted),
            work.link.calendarId,
            work.link.eventId
          );
      } catch (error) {
        await this.repository.recordFailure(work, error);
        return "pending";
      }
    }

    const etag = rotated || !work.link ? undefined : work.link.etag ?? undefined;
    try {
      const event = await this.client(work.target.connectionId)
        .upsertEvent(
          this.refreshToken(work.target.refreshTokenEncrypted),
          work.target.calendarId,
          work.eventId,
          work.fields,
          etag
        );
      return await this.repository.complete(work, { etag: event.etag ?? null });
    } catch (error) {
      if (this.isApiError(error)) {
        if ((error.status === 404 || error.status === 410) && etag !== undefined) {
          // Evento sumiu do Google depois do nosso último sync: não recriar
          // (o usuário pode ter apagado de propósito) — conflito observável.
          return await this.repository.complete(work, { conflict: "evento removido no Google; reconciliação manual" });
        }
        if (error.status === 412 && etag !== undefined) {
          // Conflito de etag: só sobrescreve se os horários não divergirem.
          const fresh = await this.client(work.target.connectionId)
            .getEvent(
              this.refreshToken(work.target.refreshTokenEncrypted),
              work.target.calendarId,
              work.eventId
            );
          if (eventTimesMatch(fresh, work.fields)) {
            const repatched = await this.client(work.target.connectionId)
              .upsertEvent(
                this.refreshToken(work.target.refreshTokenEncrypted),
                work.target.calendarId,
                work.eventId,
                work.fields
              );
            return await this.repository.complete(work, { etag: repatched.etag ?? null });
          }
          return await this.repository.complete(work, { conflict: "evento movido no Google; reconciliação manual" });
        }
      }
      await this.repository.recordFailure(work, error);
      return "pending";
    }
  }
}

export async function drainCalendarSyncOutbox(
  repository: CalendarSyncRepository,
  processor: CalendarSyncProcessor,
  limit = OUTBOX_BATCH_LIMIT
): Promise<number> {
  const jobs = await repository.claimDue(limit);
  for (const job of jobs) {
    try {
      const outcome = await processor.process(job);
      if (outcome === "pending") logger.warn(
        { tenantId: job.tenantId, appointmentId: job.appointmentId, kind: job.kind, attempts: job.attempts },
        "Calendar sync attempt failed; outbox will retry with backoff"
      );
    } catch (error) {
      // complete()/recordFailure() falhou no banco: claim expira sozinho pelo lease.
      logger.warn(
        { err: errorMessage(error), tenantId: job.tenantId, appointmentId: job.appointmentId },
        "Calendar sync job crashed; lease expiry will re-claim it"
      );
    }
  }
  return jobs.length;
}

export async function reconcileLinkedCalendarEvents(
  repository: CalendarSyncRepository,
  processor: CalendarSyncProcessor,
  options: { limit?: number; staleMs?: number; now?: Date } = {}
): Promise<number> {
  const now = options.now ?? new Date();
  const links = await repository.claimStaleLinked(options.limit, options.staleMs);
  for (const link of links) {
    let event: GoogleCalendarEvent | null = null;
    let removed = false;
    try {
      event = await processor.client(link.connectionId)
        .getEvent(
          processor.readLinkedToken(link.refreshTokenEncrypted),
          link.calendarId,
          link.eventId
        );
    } catch (error) {
      // 404/410: evento removido no Google — vira ADOÇÃO do cancelamento abaixo.
      // Demais erros: sem mudança local; próxima passada reavalia.
      if (error instanceof GoogleCalendarApiError && (error.status === 404 || error.status === 410)) {
        removed = true;
      } else {
        logger.debug(
          { err: errorMessage(error), tenantId: link.tenantId, appointmentId: link.appointmentId },
          "Linked calendar event reconciliation read failed"
        );
        continue;
      }
    }
    if (!removed && event && event.status !== "cancelled") {
      const moved = !eventTimesMatch(event, {
        start: { dateTime: link.startAt.toISOString() },
        end: { dateTime: link.endAt.toISOString() }
      } as GoogleCalendarEventFields);
      if (!moved) {
        // Em sincronia (ou edição estética no Google): valida e libera o erro antigo.
        await repository.applyReconciliation(link, link.claimedAt, { etag: event.etag ?? null });
        continue;
      }
    }
    // Mudança real no Google → adoção inbound (spec: mudanças no Google refletem
    // no AtendON). O snapshot lido NO CLAIM é a guarda CAS: edição concorrente do
    // painel entre claim e adoção → 409 → conflito observável, nunca sobrescrever.
    try {
      const result = await adoptGoogleCalendarChange({
        tenantId: link.tenantId,
        appointmentId: link.appointmentId,
        localSnapshot: {
          status: link.status as AppointmentStatus,
          startAt: link.startAt.toISOString(),
          endAt: link.endAt.toISOString()
        },
        event: removed ? null : event,
        notFound: removed || undefined,
        now
      });
      if (result.kind === "conflict") {
        await repository.applyReconciliation(link, link.claimedAt, { conflict: result.reason });
        continue;
      }
      // adopted: o gatilho 0189 enfileira o upsert/delete que converge com o
      // remoto (horários já iguais; delete idempotente 404/410). unchanged: já
      // em sincronia. Ambos atualizam etag e liberam erro antigo no vínculo.
      await repository.applyReconciliation(link, link.claimedAt, { etag: event?.etag ?? null });
    } catch (error) {
      // Erro DENTRO da adoção (Google indisponível na freeBusy, rede): sem
      // mudança local; próxima passada reavalia. Não confundir com o 404/410
      // da leitura, já tratado acima.
      logger.debug(
        { err: errorMessage(error), tenantId: link.tenantId, appointmentId: link.appointmentId },
        "Linked calendar event adoption failed"
      );
    }
  }
  return links.length;
}

export type CalendarSyncWorkerHandle = { stop(): Promise<void> };

export function startCalendarSyncWorker(options: {
  pool?: Pool;
  // Costura explícita p/ testes: drenagem lenta observável sem timers falsos.
  repository?: CalendarSyncRepository;
  intervalMs?: number;
  leaseMs?: number;
  linksIntervalMs?: number;
} = {}): CalendarSyncWorkerHandle {
  const repository = options.repository ?? new CalendarSyncRepository(options.pool ?? db, options.leaseMs);
  const processor = new CalendarSyncProcessor(repository);
  let pump: Promise<void> | null = null;
  let reconcile: Promise<void> | null = null;

  const runPump = (): void => {
    if (pump) return; // drenagem anterior em voo: pula o tick (sem sobrepor)
    pump = drainCalendarSyncOutbox(repository, processor).then(
      () => undefined,
      (error) => logger.error({ err: errorMessage(error) }, "Calendar sync outbox pump failed")
    ).finally(() => { pump = null; });
  };
  const runReconcile = (): void => {
    if (reconcile) return; // reconciliação anterior em voo: pula o tick
    reconcile = reconcileLinkedCalendarEvents(repository, processor).then(
      () => undefined,
      (error) => logger.error({ err: errorMessage(error) }, "Calendar linked events reconciliation failed")
    ).finally(() => { reconcile = null; });
  };

  const pumpTimer = setInterval(runPump, options.intervalMs ?? 10_000);
  pumpTimer.unref();
  const linksTimer = setInterval(runReconcile, options.linksIntervalMs ?? LINKS_INTERVAL_MS);
  linksTimer.unref();
  runPump();
  runReconcile();

  return {
    stop: async () => {
      clearInterval(pumpTimer);
      clearInterval(linksTimer);
      await Promise.allSettled([pump, reconcile].filter(Boolean) as Promise<unknown>[]);
    }
  };
}
