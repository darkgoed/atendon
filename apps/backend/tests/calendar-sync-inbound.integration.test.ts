// Integração: sincronização BIDIRECIONAL do evento vinculado Google↔AtendON
// (specs/active/google-calendar-team-sync). O reconciliation do worker não
// apenas marca conflito: lê o evento no Google e ADOTA a mudança
// (adoptGoogleCalendarChange) — movimento reagenda com guarda CAS do snapshot
// lido no claim (edição concorrente do painel → 409, nada é sobrescrito),
// cancelamento/404/410 adota o cancelamento pela jornada — e o gatilho 0189
// reenfileira o outbox que converge com o remoto (sem evento duplicado).
// Banco real (Postgres de teste); Google 100% stubado nas duas costuras
// (createClient do CalendarSyncProcessor + setCalendarBookingClientFactory).
// Também cobre a remoção do Meet não solicitado: o sync nunca envia
// conferenceData.createRequest — usa o meeting_url existente na descrição.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ensureWorkspaceDefaultRoles } from "../src/auth/rbac.js";
import { config } from "../src/config.js";
import { seedTenantCapabilities } from "./helpers/capability-seed.js";
import { encryptSecret } from "../src/modules/ai-router/secret-box.js";
import { setCalendarBookingClientFactory, type CalendarBookingClient } from "../src/modules/scheduling/calendar-booking.js";
import {
  CalendarSyncProcessor,
  CalendarSyncRepository,
  reconcileLinkedCalendarEvents,
  type CalendarSyncJob
} from "../src/modules/scheduling/calendar-sync.js";
import {
  atendonCalendarEventId,
  GoogleCalendarApiError,
  type GoogleCalendarClient,
  type GoogleCalendarEvent,
  type GoogleCalendarEventFields
} from "../src/modules/scheduling/google-calendar.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const repo = new CalendarSyncRepository(pool);
const processor = new CalendarSyncProcessor(repo, () => fakeClient);

// Instantes FIXOS (mesmo padrão de calendar-inbound-adoption): segunda
// 05/10/2026 09:00Z; agendamento 13:00-14:00Z (futuro para o now() real do
// banco, dentro do horário da unidade 08:00-18:00 local).
const NOW = new Date("2026-10-05T09:00:00Z");
const SLOT_START = "2026-10-05T13:00:00.000Z";
const SLOT_END = "2026-10-05T14:00:00.000Z";
const MOVE_START = "2026-10-05T15:00:00.000Z";
const MOVE_END = "2026-10-05T16:00:00.000Z";
// Forma offset (-03:00) == 15:00-16:00Z: prova conversão de fuso na adoção.
const GOOGLE_MOVED: GoogleCalendarEvent = {
  id: "evt-1", etag: "g-1", status: "confirmed",
  start: { dateTime: "2026-10-05T12:00:00-03:00" },
  end: { dateTime: "2026-10-05T13:00:00-03:00" }
} as unknown as GoogleCalendarEvent;
const CAL_A = "cal-inbound-a";
const CREATE_OPTIONS = { manual: true, allowExplicitAssignee: true, now: NOW } as const;

let tenantId = "";
let memberId = "";

type Call = { token: string; calendarId: string; eventId: string };
const calls = {
  upserts: [] as Array<Call & { fields: GoogleCalendarEventFields; etag?: string }>,
  deletes: [] as Call[],
  gets: [] as Array<Call & { beforeGet?: () => Promise<void> | void }>
};
let upsertError: unknown = null;
let getEventError: unknown = null;
let remoteEvent: GoogleCalendarEvent | null = null;
let beforeGet: (() => Promise<void> | void) | null = null;
let etagSeq = 0;

function resetFake(): void {
  calls.upserts.length = 0;
  calls.deletes.length = 0;
  calls.gets.length = 0;
  upsertError = null;
  getEventError = null;
  remoteEvent = null;
  beforeGet = null;
  etagSeq = 0;
}

const fakeClient = {
  async upsertEvent(
    token: string,
    calendarId: string,
    eventId: string,
    fields: GoogleCalendarEventFields,
    etag?: string
  ): Promise<GoogleCalendarEvent> {
    calls.upserts.push({ token, calendarId, eventId, fields, etag });
    if (upsertError) throw upsertError;
    etagSeq += 1;
    return { id: eventId, etag: `etag-${etagSeq}`, start: fields.start, end: fields.end };
  },
  async deleteEvent(token: string, calendarId: string, eventId: string): Promise<void> {
    calls.deletes.push({ token, calendarId, eventId });
  },
  async getEvent(token: string, calendarId: string, eventId: string): Promise<GoogleCalendarEvent> {
    calls.gets.push({ token, calendarId, eventId });
    if (beforeGet) await beforeGet(); // mutação concorrente injetada no meio da leitura
    if (getEventError) throw getEventError;
    if (!remoteEvent) throw new Error("stub: remoteEvent não configurado");
    return remoteEvent;
  }
} as unknown as GoogleCalendarClient;

// freeBusy/listEvents do serviço de domínio (reschedule durante a adoção):
// agenda livre — a exclusão do evento vinculado próprio é por identidade.
const bookingFake = {
  freeBusy: async (): Promise<never[]> => [],
  listEvents: async (): Promise<never[]> => []
} as unknown as CalendarBookingClient;

async function createMember(client: pg.PoolClient): Promise<string> {
  const roles = await client.query<{ id: string }>(
    "SELECT id FROM workspace_roles WHERE workspace_id=$1 AND name='OPERADOR'",
    [tenantId]
  );
  const user = (await client.query<{ id: string }>(
    "INSERT INTO users(email,password_hash,status) VALUES($1,'x','active') RETURNING id",
    [`inbound-${randomUUID()}@test.local`]
  )).rows[0].id;
  const member = (await client.query<{ id: string }>(
    `INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at)
     VALUES($1,$2,$3,'active',now()) RETURNING id`,
    [tenantId, user, roles.rows[0].id]
  )).rows[0].id;
  // Closer do pool: loadExplicitAppointmentAttendant exige (reagendamento com
  // responsável explícito passa por aqui).
  await client.query(
    "INSERT INTO scheduling_google_meet_closers(tenant_id,member_id) VALUES($1,$2)",
    [tenantId, member]
  );
  return member;
}

beforeAll(async () => {
  tenantId = (await pool.query<{ id: string }>(
    "INSERT INTO tenants(name,status,timezone) VALUES($1,'active','America/Sao_Paulo') RETURNING id",
    [`Calendar Sync Inbound ${randomUUID()}`]
  )).rows[0].id;
  await seedTenantCapabilities(pool, [tenantId]);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await ensureWorkspaceDefaultRoles(client, tenantId);
    memberId = await createMember(client);
    await client.query(
      `INSERT INTO scheduling_units(tenant_id,id,name,opening_time,closing_time,operating_days,slot_duration_min,simultaneous_capacity)
       VALUES($1,'unit','Unit','08:00','18:00',ARRAY[1,2,3,4,5]::smallint[],60,3)`,
      [tenantId]
    );
    await client.query("INSERT INTO whatsapp_sessions(tenant_id,status) VALUES($1,'connected')", [tenantId]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  await pool.query(
    `INSERT INTO scheduling_calendar_connections(tenant_id,member_id,google_email,refresh_token_encrypted,calendar_id,buffer_minutes)
     VALUES($1,$2,$3,$4,$5,0)`,
    [tenantId, memberId, `${memberId}@test.local`, encryptSecret("rt-inbound", config.DATA_ENCRYPTION_KEY), CAL_A]
  );
  setCalendarBookingClientFactory(() => bookingFake);
});

afterAll(async () => {
  setCalendarBookingClientFactory(null);
  await pool.query("DELETE FROM tenants WHERE id=$1", [tenantId]);
  await pool.end();
});

// Cada teste cria o próprio lead/agenda: o pool de closers e a capacidade
// da unidade não podem ver agendamentos alheios.
beforeEach(async () => {
  resetFake();
  await pool.query("DELETE FROM scheduling_appointments WHERE tenant_id=$1", [tenantId]);
  await pool.query("DELETE FROM system_alerts WHERE tenant_id=$1", [tenantId]);
});

async function createLeadAppointment(): Promise<string> {
  const phone = `5511${Math.floor(910_000_000 + Math.random() * 89_999_999)}`;
  const leadId = (await pool.query<{ id: string }>(
    "INSERT INTO scheduling_leads(tenant_id,phone,name,source,assigned_member_id) VALUES($1,$2,'Lead','test',$3) RETURNING id",
    [tenantId, phone, memberId]
  )).rows[0].id;
  const sessionId = (await pool.query<{ id: string }>(
    "SELECT id FROM whatsapp_sessions WHERE tenant_id=$1 LIMIT 1",
    [tenantId]
  )).rows[0].id;
  await pool.query(
    "INSERT INTO conversations(tenant_id,session_id,contact_phone,contact_name,ai_active) VALUES($1,$2,$3,'Lead',true)",
    [tenantId, sessionId, phone]
  );
  const appointment = await (await import("../src/modules/scheduling/service.js")).createAppointment(
    tenantId,
    { lead_id: leadId, unidade_id: "unit", start: SLOT_START, assigned_member_id: memberId },
    CREATE_OPTIONS
  );
  return appointment.id as string;
}

async function claimOne(appointmentId: string): Promise<CalendarSyncJob> {
  // claimDue é global: escolhe a linha alvo entre eventuais residuais.
  const jobs = await repo.claimDue(100);
  const job = jobs.find((candidate) => candidate.appointmentId === appointmentId);
  expect(job, `linha do outbox de ${appointmentId} não estava disponível`).toBeDefined();
  return job!;
}

// Publica o evento no Google (fake) até o vínculo existir.
async function syncAppointment(appointmentId: string): Promise<void> {
  const outcome = await processor.process(await claimOne(appointmentId));
  expect(outcome).toBe("synced");
}

async function staleLink(appointmentId: string): Promise<void> {
  await pool.query(
    "UPDATE scheduling_appointment_calendar_events SET last_synced_at=now() - interval '10 minutes' WHERE appointment_id=$1",
    [appointmentId]
  );
}

async function appointmentRow(appointmentId: string): Promise<{
  status: string; start_at: Date; end_at: Date;
}> {
  return (await pool.query<{ status: string; start_at: Date; end_at: Date }>(
    "SELECT status,start_at,end_at FROM scheduling_appointments WHERE id=$1",
    [appointmentId]
  )).rows[0];
}

async function leadOfAppointment(appointmentId: string): Promise<{
  status: string; recovery_required: boolean; recovery_member_id: string | null;
}> {
  return (await pool.query<{ status: string; recovery_required: boolean; recovery_member_id: string | null }>(
    `SELECT l.status,l.recovery_required,l.recovery_member_id
     FROM scheduling_appointments a JOIN scheduling_leads l ON l.id=a.lead_id
     WHERE a.id=$1`,
    [appointmentId]
  )).rows[0];
}

async function linkRow(appointmentId: string): Promise<{
  connection_id: string | null; calendar_id: string; event_id: string;
  etag: string | null; sync_error: string | null;
} | null> {
  return (await pool.query(
    `SELECT connection_id,calendar_id,event_id,etag,sync_error
     FROM scheduling_appointment_calendar_events WHERE appointment_id=$1 AND tenant_id=$2`,
    [appointmentId, tenantId]
  )).rows[0] ?? null;
}

async function outboxRow(appointmentId: string): Promise<{ kind: string } | null> {
  return (await pool.query<{ kind: string }>(
    "SELECT kind FROM scheduling_calendar_sync_outbox WHERE appointment_id=$1 AND tenant_id=$2",
    [appointmentId, tenantId]
  )).rows[0] ?? null;
}

async function conflictAlertCount(appointmentId: string): Promise<number> {
  return (await pool.query<{ n: number }>(
    `SELECT count(*)::int n FROM system_alerts
     WHERE tenant_id=$1 AND metadata->>'event'='calendar_event_conflict'
       AND metadata->>'appointment_id'=$2`,
    [tenantId, appointmentId]
  )).rows[0].n;
}

describe("reconciliação adota mudanças do Google (bidirecional)", () => {
  it("evento movido no Google: AtendON reagenda e o outbox converge sem duplicar evento", async () => {
    const appointmentId = await createLeadAppointment();
    await syncAppointment(appointmentId);
    const firstEtag = (await linkRow(appointmentId))?.etag;
    await staleLink(appointmentId);
    remoteEvent = GOOGLE_MOVED;

    expect(await reconcileLinkedCalendarEvents(repo, processor, { now: NOW })).toBe(1);

    // Adotado: horários locais viram os do Google (offset -03:00 → UTC exato).
    const row = await appointmentRow(appointmentId);
    expect(row.status).toBe("confirmado");
    expect(row.start_at.toISOString()).toBe(MOVE_START);
    expect(row.end_at.toISOString()).toBe(MOVE_END);
    // Vínculo sem erro, etag fresco do GET (nada de marca de leitura velha).
    const link = await linkRow(appointmentId);
    expect(link?.sync_error).toBeNull();
    expect(link?.etag).toBe("g-1");
    expect(await conflictAlertCount(appointmentId)).toBe(0);

    // Convergência outbound: gatilho 0189 reenfileirou; o push usa o MESMO
    // event id (sem duplicar) com If-Match do etag adotado e horários já iguais.
    expect(await outboxRow(appointmentId)).toMatchObject({ kind: "upsert" });
    expect(await processor.process(await claimOne(appointmentId))).toBe("synced");
    expect(await outboxRow(appointmentId)).toBeNull();
    const eventIds = new Set(calls.upserts.map((call) => call.eventId));
    expect(eventIds.size).toBe(1);
    expect(eventIds.has(atendonCalendarEventId(appointmentId))).toBe(true);
    expect(calls.upserts.at(-1)?.etag).toBe("g-1");
    expect(calls.upserts.at(-1)?.fields.start?.dateTime).toBe(MOVE_START);
    expect(calls.upserts.at(-1)?.fields.end?.dateTime).toBe(MOVE_END);
    expect(firstEtag).not.toBe("g-1");
  });

  it("evento cancelado no Google: adota cancelamento pela jornada e o delete do outbox apaga o vínculo", async () => {
    const appointmentId = await createLeadAppointment();
    await syncAppointment(appointmentId);
    await staleLink(appointmentId);
    remoteEvent = { ...GOOGLE_MOVED, status: "cancelled" };

    expect(await reconcileLinkedCalendarEvents(repo, processor, { now: NOW })).toBe(1);

    const row = await appointmentRow(appointmentId);
    expect(row.status).toBe("cancelado");
    const lead = await leadOfAppointment(appointmentId);
    expect(lead.status).toBe("follow_up");
    expect(lead.recovery_required).toBe(true);
    expect(lead.recovery_member_id).toBe(memberId);
    expect(await conflictAlertCount(appointmentId)).toBe(0);

    // Cancelamento local dispara kind='delete'; a exclusão remota confirmada
    // (fake 2xx) apaga o vínculo — igual ao cancelamento originado no AtendON.
    expect(await outboxRow(appointmentId)).toMatchObject({ kind: "delete" });
    expect(await processor.process(await claimOne(appointmentId))).toBe("synced");
    expect(calls.deletes).toEqual([{
      token: "rt-inbound", calendarId: CAL_A, eventId: atendonCalendarEventId(appointmentId)
    }]);
    expect(await linkRow(appointmentId)).toBeNull();
    expect(await outboxRow(appointmentId)).toBeNull();
  });

  it("404/410 na leitura (evento removido no Google): adota cancelamento em vez de conflito", async () => {
    const appointmentId = await createLeadAppointment();
    await syncAppointment(appointmentId);
    await staleLink(appointmentId);
    getEventError = new GoogleCalendarApiError(
      "O Google recusou a leitura do evento no Calendar (HTTP 404)", "failed", 404
    );

    expect(await reconcileLinkedCalendarEvents(repo, processor, { now: NOW })).toBe(1);

    expect((await appointmentRow(appointmentId)).status).toBe("cancelado");
    expect((await leadOfAppointment(appointmentId)).status).toBe("follow_up");
    expect(await conflictAlertCount(appointmentId)).toBe(0);
    expect(await outboxRow(appointmentId)).toMatchObject({ kind: "delete" });
    expect(await processor.process(await claimOne(appointmentId))).toBe("synced");
    expect(await linkRow(appointmentId)).toBeNull();
  });

  it("edição concorrente do painel entre claim e adoção: conflito 409 e nada é sobrescrito", async () => {
    const appointmentId = await createLeadAppointment();
    await syncAppointment(appointmentId);
    await staleLink(appointmentId);
    remoteEvent = GOOGLE_MOVED;
    // A leitura do Google acontece DEPOIS do claim: a edição do painel no meio
    // invalida o snapshot do claim → CAS 409 dentro do serviço de domínio.
    beforeGet = async () => {
      const { rescheduleAppointment } = await import("../src/modules/scheduling/service.js");
      await rescheduleAppointment(
        tenantId, appointmentId,
        { start: MOVE_START, end: MOVE_END, unidade_id: "unit" },
        { manual: true, now: NOW }
      );
    };

    expect(await reconcileLinkedCalendarEvents(repo, processor, { now: NOW })).toBe(1);

    // Painel vence: horários permanecem os da edição concorrente.
    const row = await appointmentRow(appointmentId);
    expect(row.start_at.toISOString()).toBe(MOVE_START); // edição do painel, não revertida
    const link = await linkRow(appointmentId);
    expect(link?.sync_error).toContain("alterado por outra operação");
    expect(await conflictAlertCount(appointmentId)).toBe(1);
    // 2º ciclo: conflito persiste → alerta NÃO se repete (sem spam).
    await staleLink(appointmentId);
    remoteEvent = null;
    beforeGet = null;
    await reconcileLinkedCalendarEvents(repo, processor, { now: NOW });
    expect(await conflictAlertCount(appointmentId)).toBe(1);
  });
});

describe("sem Meet não solicitado no evento publicado", () => {
  it("agendamento sem reunião: campos do evento sem conferenceData (nada de Meet órfão)", async () => {
    const appointmentId = await createLeadAppointment();
    await syncAppointment(appointmentId);
    expect(calls.upserts).toHaveLength(1);
    expect(calls.upserts[0].fields.conferenceData).toBeUndefined();
  });

  it("agendamento com meeting_url provisionado: link existente vai na descrição, sem conferenceData", async () => {
    const appointmentId = await createLeadAppointment();
    // Tupla completa exigida pelo CHECK de meeting fields (provider+space+code+url+created_at).
    await pool.query(
      `UPDATE scheduling_appointments
       SET meeting_provider='google_meet',meeting_space_name='spaces/1',meeting_code='abc-defg-hij',
           meeting_url='https://meet.google.com/abc-defg-hij',meeting_created_at=now()
       WHERE id=$1`,
      [appointmentId]
    );
    await syncAppointment(appointmentId);
    expect(calls.upserts).toHaveLength(1);
    expect(calls.upserts[0].fields.conferenceData).toBeUndefined();
    expect(calls.upserts[0].fields.description).toContain("https://meet.google.com/abc-defg-hij");
  });
});
