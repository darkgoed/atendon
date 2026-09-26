// Integração: adoção inbound Google→AtendON (adoptGoogleCalendarChange) para
// eventos JÁ vinculados (specs/active/google-calendar-team-sync). Banco real;
// HTTP do Google só via setCalendarBookingClientFactory (seam de teste, freeBusy).
// Cobertura: CAS de timeline (snapshot lido antes do Google → guarda 409 sob
// lock), snapshot desatualizado não muta nada, mudança adotada preserva fuso
// (offset → instante UTC) e duração, cancelamento 404/410/status-cancelled
// adota via cancelAppointment com jornada recover, evento busy no Google do
// responsável aborta como conflito, e linha local não ativa nunca é adotada.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ensureWorkspaceDefaultRoles } from "../src/auth/rbac.js";
import { config } from "../src/config.js";
import { seedTenantCapabilities } from "./helpers/capability-seed.js";
import { encryptSecret } from "../src/modules/ai-router/secret-box.js";
import { setCalendarBookingClientFactory, type CalendarBookingClient } from "../src/modules/scheduling/calendar-booking.js";
import { adoptGoogleCalendarChange } from "../src/modules/scheduling/calendar-inbound.js";
import type { GoogleCalendarEvent } from "../src/modules/scheduling/google-calendar.js";
import { cancelAppointment, createAppointment, rescheduleAppointment } from "../src/modules/scheduling/service.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
// Segunda 05/10/2026 09:00Z — dentro de 08:00-18:00, dias úteis (UTC e UTC-3).
const NOW = new Date("2026-10-05T09:00:00Z");
const SLOT_START = "2026-10-05T13:00:00.000Z";
const SLOT_END = "2026-10-05T14:00:00.000Z";
// Movimento do Google em forma offset (-03:00) == 15:00-16:00Z: prova fuso+duração.
const GOOGLE_MOVED: GoogleCalendarEvent = {
  id: "evt-1", etag: "e", status: "confirmed",
  start: { dateTime: "2026-10-05T12:00:00-03:00" },
  end: { dateTime: "2026-10-05T13:00:00-03:00" }
} as unknown as GoogleCalendarEvent;
const MOVE_START = "2026-10-05T15:00:00.000Z";
const MOVE_END = "2026-10-05T16:00:00.000Z";
const CREATE_OPTIONS = { manual: true, allowExplicitAssignee: true, now: NOW };
const ACTIVE_SNAPSHOT = { status: "confirmado" as const, startAt: SLOT_START, endAt: SLOT_END };

let tenantId = "";
let memberId = "";

beforeAll(async () => {
  tenantId = (await pool.query<{ id: string }>(
    "INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id",
    [`InboundAdopt ${randomUUID()}`]
  )).rows[0].id;
  await seedTenantCapabilities(pool, [tenantId]);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await ensureWorkspaceDefaultRoles(client, tenantId);
    const roles = await client.query<{ id: string }>(
      "SELECT id FROM workspace_roles WHERE workspace_id=$1 AND name='OPERADOR'",
      [tenantId]
    );
    const user = (await client.query<{ id: string }>(
      "INSERT INTO users(email,password_hash,status) VALUES($1,'x','active') RETURNING id",
      [`closer-${randomUUID()}@test.local`]
    )).rows[0].id;
    memberId = (await client.query<{ id: string }>(
      "INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at) VALUES($1,$2,$3,'active',now()) RETURNING id",
      [tenantId, user, roles.rows[0].id]
    )).rows[0].id;
    await client.query("INSERT INTO scheduling_google_meet_closers(tenant_id,member_id) VALUES($1,$2)", [tenantId, memberId]);
    await client.query(
      "INSERT INTO scheduling_units(tenant_id,id,name,opening_time,closing_time,operating_days,slot_duration_min,simultaneous_capacity) VALUES($1,'unit','Unit','08:00','18:00',ARRAY[1,2,3,4,5]::smallint[],60,3)",
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
});

afterAll(async () => {
  setCalendarBookingClientFactory(null);
  await pool.query("DELETE FROM tenants WHERE name LIKE 'InboundAdopt %'");
  await pool.end();
});

// Cada teste cria o próprio lead/agenda: limpa para o pool de closers e o
// check de capacidade não verem agendamentos alheios.
afterEach(async () => {
  await pool.query("DELETE FROM scheduling_calendar_connections WHERE tenant_id=$1", [tenantId]);
  await pool.query("DELETE FROM scheduling_appointments WHERE tenant_id=$1", [tenantId]);
  await pool.query("DELETE FROM system_alerts WHERE tenant_id=$1", [tenantId]);
  await pool.query("DELETE FROM conversations WHERE tenant_id=$1", [tenantId]);
  await pool.query("DELETE FROM scheduling_leads WHERE tenant_id=$1", [tenantId]);
});

async function connectMember() {
  await pool.query(
    `INSERT INTO scheduling_calendar_connections(tenant_id,member_id,google_email,refresh_token_encrypted,calendar_id,buffer_minutes)
     VALUES($1,$2,$3,$4,'cal-inbound',0)`,
    [tenantId, memberId, `${memberId}@test.local`, encryptSecret(`refresh-${memberId}`, config.DATA_ENCRYPTION_KEY)]
  );
}

async function createLeadAppointment(start: string, assignedMemberId?: string): Promise<{ appointmentId: string; leadId: string }> {
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
  const appointment = await createAppointment(
    tenantId,
    assignedMemberId
      ? { lead_id: leadId, unidade_id: "unit", start, assigned_member_id: assignedMemberId }
      : { lead_id: leadId, unidade_id: "unit", start },
    CREATE_OPTIONS
  );
  return { appointmentId: appointment.id as string, leadId };
}

async function fillSlot(start: string, count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) await createLeadAppointment(start);
}

async function stateSnapshot(leadId: string, appointmentId: string): Promise<string> {
  const appointment = (await pool.query(
    "SELECT row_to_json(a.*) AS row FROM scheduling_appointments a WHERE a.id=$1",
    [appointmentId]
  )).rows[0].row;
  const lead = (await pool.query(
    "SELECT row_to_json(l.*) AS row FROM scheduling_leads l WHERE l.id=$1",
    [leadId]
  )).rows[0].row;
  const events = (await pool.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM scheduling_lead_events WHERE lead_id=$1",
    [leadId]
  )).rows[0].count;
  const outbox = (await pool.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM scheduling_calendar_sync_outbox WHERE tenant_id=$1",
    [tenantId]
  )).rows[0].count;
  return JSON.stringify({ appointment, lead, events, outbox });
}

describe("adoptGoogleCalendarChange (google-calendar-team-sync inbound)", () => {
  it("evento movido com offset -03:00: adota instante UTC e duração exatos", async () => {
    const { appointmentId, leadId } = await createLeadAppointment(SLOT_START);
    const result = await adoptGoogleCalendarChange({
      tenantId, appointmentId, localSnapshot: ACTIVE_SNAPSHOT, event: GOOGLE_MOVED, now: NOW
    });
    expect(result.kind).toBe("adopted");
    if (result.kind === "adopted" && result.action === "moved") {
      expect(result.appointment.status).toBe("confirmado");
      expect((result.appointment.start as Date).toISOString()).toBe(MOVE_START);
      expect((result.appointment.end as Date).toISOString()).toBe(MOVE_END);
    }
    const row = (await pool.query<{ start_at: Date; end_at: Date }>(
      "SELECT start_at,end_at FROM scheduling_appointments WHERE id=$1",
      [appointmentId]
    )).rows[0];
    expect(row.start_at.toISOString()).toBe(MOVE_START);
    expect(row.end_at.toISOString()).toBe(MOVE_END);
    expect((await pool.query<{ status: string }>("SELECT status FROM scheduling_leads WHERE id=$1", [leadId])).rows[0].status)
      .toBe("agendado");
  });

  it("evento já em sincronia: unchanged e nada muda", async () => {
    const { appointmentId, leadId } = await createLeadAppointment(SLOT_START);
    const before = await stateSnapshot(leadId, appointmentId);
    // Mesmos instantes em forma offset diferente (10:00-03:00 == 13:00Z).
    const result = await adoptGoogleCalendarChange({
      tenantId, appointmentId, localSnapshot: ACTIVE_SNAPSHOT,
      event: { ...GOOGLE_MOVED, start: { dateTime: "2026-10-05T10:00:00-03:00" }, end: { dateTime: "2026-10-05T11:00:00-03:00" } },
      now: NOW
    });
    expect(result.kind).toBe("unchanged");
    expect(await stateSnapshot(leadId, appointmentId)).toBe(before);
  });

  it("movido sem capacidade na unidade: conflict (409) e nada muda", async () => {
    await fillSlot(MOVE_START, 3); // capacidade simultânea = 3
    const { appointmentId, leadId } = await createLeadAppointment(SLOT_START);
    const before = await stateSnapshot(leadId, appointmentId);
    const result = await adoptGoogleCalendarChange({
      tenantId, appointmentId, localSnapshot: ACTIVE_SNAPSHOT, event: GOOGLE_MOVED, now: NOW
    });
    expect(result).toMatchObject({ kind: "conflict" });
    expect(await stateSnapshot(leadId, appointmentId)).toBe(before);
  });

  it("movido para horário busy no Google do responsável: conflict (409) e nada muda", async () => {
    await connectMember();
    setCalendarBookingClientFactory(() => ({
      freeBusy: async () => [{ start: MOVE_START, end: MOVE_END }],
      getEvent: async () => { throw new Error("não deveria ler evento vinculado: vínculo inexistente"); }
    }) as unknown as CalendarBookingClient);
    const { appointmentId, leadId } = await createLeadAppointment(SLOT_START);
    const before = await stateSnapshot(leadId, appointmentId);
    const result = await adoptGoogleCalendarChange({
      tenantId, appointmentId, localSnapshot: ACTIVE_SNAPSHOT, event: GOOGLE_MOVED, now: NOW
    });
    expect(result.kind).toBe("conflict");
    if (result.kind === "conflict") expect(result.reason).toContain("compromisso no Google Calendar");
    expect(await stateSnapshot(leadId, appointmentId)).toBe(before);
  });

  it("snapshot desatualizado (CAS de timeline): conflict e nada muda", async () => {
    const { appointmentId, leadId } = await createLeadAppointment(SLOT_START);
    // Edição concorrente do painel (legado, sem guarda) entre a leitura do
    // snapshot e a adoção.
    await rescheduleAppointment(
      tenantId, appointmentId,
      { start: MOVE_START, end: MOVE_END, unidade_id: "unit" },
      { manual: true, now: NOW }
    );
    const before = await stateSnapshot(leadId, appointmentId);
    // Chamador Google com snapshot lido antes da edição do painel.
    const result = await adoptGoogleCalendarChange({
      tenantId, appointmentId, localSnapshot: ACTIVE_SNAPSHOT, event: GOOGLE_MOVED, now: NOW
    });
    expect(result.kind).toBe("conflict");
    if (result.kind === "conflict") expect(result.reason).toContain("alterado por outra operação");
    expect(await stateSnapshot(leadId, appointmentId)).toBe(before);
  });

  it("status cancelled no Google: adota cancelamento com jornada recover", async () => {
    const { appointmentId, leadId } = await createLeadAppointment(SLOT_START);
    const result = await adoptGoogleCalendarChange({
      tenantId, appointmentId, localSnapshot: ACTIVE_SNAPSHOT,
      event: { ...GOOGLE_MOVED, status: "cancelled" }, now: NOW
    });
    expect(result).toMatchObject({ kind: "adopted", action: "cancelled" });
    expect((await pool.query<{ status: string }>("SELECT status FROM scheduling_appointments WHERE id=$1", [appointmentId])).rows[0].status)
      .toBe("cancelado");
    const lead = (await pool.query<{ status: string; recovery_required: boolean; recovery_member_id: string | null }>(
      "SELECT status,recovery_required,recovery_member_id FROM scheduling_leads WHERE id=$1", [leadId]
    )).rows[0];
    expect(lead.status).toBe("follow_up");
    expect(lead.recovery_required).toBe(true);
    expect(lead.recovery_member_id).toBe(memberId);
  });

  it("404/410 (notFound): adota cancelamento", async () => {
    const { appointmentId, leadId } = await createLeadAppointment(SLOT_START);
    const result = await adoptGoogleCalendarChange({
      tenantId, appointmentId, localSnapshot: ACTIVE_SNAPSHOT, notFound: true, now: NOW
    });
    expect(result).toMatchObject({ kind: "adopted", action: "cancelled" });
    expect((await pool.query<{ status: string }>("SELECT status FROM scheduling_appointments WHERE id=$1", [appointmentId])).rows[0].status)
      .toBe("cancelado");
    expect((await pool.query<{ status: string }>("SELECT status FROM scheduling_leads WHERE id=$1", [leadId])).rows[0].status)
      .toBe("follow_up");
  });

  it("linha local não ativa: unchanged e jornada intacta", async () => {
    const { appointmentId, leadId } = await createLeadAppointment(SLOT_START);
    await cancelAppointment(tenantId, appointmentId);
    const before = await stateSnapshot(leadId, appointmentId);
    const result = await adoptGoogleCalendarChange({
      tenantId, appointmentId,
      localSnapshot: { status: "cancelado", startAt: SLOT_START, endAt: SLOT_END },
      event: { ...GOOGLE_MOVED, status: "cancelled" },
      now: NOW
    });
    expect(result.kind).toBe("unchanged");
    expect(await stateSnapshot(leadId, appointmentId)).toBe(before);
  });

  it("recusas de validação: dia inteiro e passado", async () => {
    const { appointmentId } = await createLeadAppointment(SLOT_START);
    const allDay = await adoptGoogleCalendarChange({
      tenantId, appointmentId, localSnapshot: ACTIVE_SNAPSHOT,
      event: { ...GOOGLE_MOVED, start: { date: "2026-10-06" }, end: { date: "2026-10-07" } },
      now: NOW
    });
    expect(allDay).toMatchObject({ kind: "conflict" });
    const inPast = await adoptGoogleCalendarChange({
      tenantId, appointmentId, localSnapshot: ACTIVE_SNAPSHOT,
      event: { ...GOOGLE_MOVED, start: { dateTime: "2026-10-05T08:00:00.000Z" }, end: { dateTime: "2026-10-05T09:00:00.000Z" } },
      now: NOW
    });
    expect(inPast).toMatchObject({ kind: "conflict" });
    expect((await pool.query<{ start_at: Date }>(
      "SELECT start_at FROM scheduling_appointments WHERE id=$1", [appointmentId]
    )).rows[0].start_at.toISOString()).toBe(SLOT_START);
  });

  it("movido para data futura além de 24h: adotado", async () => {
    const { appointmentId, leadId } = await createLeadAppointment(SLOT_START);
    const result = await adoptGoogleCalendarChange({
      tenantId, appointmentId, localSnapshot: ACTIVE_SNAPSHOT,
      event: { ...GOOGLE_MOVED, start: { dateTime: "2026-10-06T10:00:00.000Z" }, end: { dateTime: "2026-10-06T11:00:00.000Z" } },
      now: NOW
    });
    expect(result).toMatchObject({ kind: "adopted", action: "moved" });
    const row = (await pool.query<{ start_at: Date; end_at: Date }>(
      "SELECT start_at,end_at FROM scheduling_appointments WHERE id=$1", [appointmentId]
    )).rows[0];
    expect(row.start_at.toISOString()).toBe("2026-10-06T10:00:00.000Z");
    expect(row.end_at.toISOString()).toBe("2026-10-06T11:00:00.000Z");
    expect((await pool.query<{ status: string }>("SELECT status FROM scheduling_leads WHERE id=$1", [leadId])).rows[0].status)
      .toBe("agendado");
  });

  it("duração acima de 24h: rejeitada pelo domínio", async () => {
    const { appointmentId } = await createLeadAppointment(SLOT_START);
    const result = await adoptGoogleCalendarChange({
      tenantId, appointmentId, localSnapshot: ACTIVE_SNAPSHOT,
      event: { ...GOOGLE_MOVED, start: { dateTime: "2026-10-06T10:00:00.000Z" }, end: { dateTime: "2026-10-07T11:00:00.000Z" } },
      now: NOW
    });
    expect(result.kind).toBe("conflict");
    if (result.kind === "conflict") expect(result.reason).toContain("duração máxima");
    expect((await pool.query<{ start_at: Date }>(
      "SELECT start_at FROM scheduling_appointments WHERE id=$1", [appointmentId]
    )).rows[0].start_at.toISOString()).toBe(SLOT_START);
  });
});
