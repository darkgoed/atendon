// Auditoria P1 (agenda): lembretes após reagendamento (F4), bloqueio recorrente
// na seleção de closer (F5), reagendamento que reativa agendamento com outro
// ativo (F9) e evento de dia inteiro do Google no fuso local (F12).
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ensureWorkspaceDefaultRoles } from "../src/auth/rbac.js";
import { config } from "../src/config.js";
import { seedTenantCapabilities } from "./helpers/capability-seed.js";
import { encryptSecret } from "../src/modules/ai-router/secret-box.js";
import { setCalendarBookingClientFactory, type CalendarBookingClient } from "../src/modules/scheduling/calendar-booking.js";
import { MeetingConfirmationRepository } from "../src/modules/scheduling/meeting-confirmation.js";
import { createAppointment, rescheduleAppointment } from "../src/modules/scheduling/service.js";
import { localDateKey, localDateTimeToUtc } from "../src/timezone.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const TZ = "America/Sao_Paulo";
// Segunda 05/10/2026 06:00 local.
const NOW = new Date("2026-10-05T09:00:00Z");
// Segunda 05/10/2026 10:00 local.
const SLOT_START = "2026-10-05T13:00:00Z";

type FakeEvent = { id: string; start: { dateTime?: string; date?: string }; end: { dateTime?: string; date?: string } };
let googleEvents: FakeEvent[] = [];
let tenantId = "";
let sessionId = "";
const members = { a: "", b: "" };

beforeEach(() => {
  googleEvents = [];
  setCalendarBookingClientFactory(() => ({
    freeBusy: async () => [],
    listEvents: async () => googleEvents
  }) as unknown as CalendarBookingClient);
});

afterEach(async () => {
  await pool.query("DELETE FROM scheduling_attendant_recurring_time_blocks WHERE tenant_id=$1", [tenantId]);
  await pool.query("DELETE FROM scheduling_calendar_connections WHERE tenant_id=$1", [tenantId]);
  await pool.query("DELETE FROM scheduling_appointments WHERE tenant_id=$1", [tenantId]);
});

beforeAll(async () => {
  tenantId = (await pool.query<{ id: string }>(
    "INSERT INTO tenants(name,status,timezone) VALUES($1,'active',$2) RETURNING id", [`AgendaP1 ${randomUUID()}`, TZ]
  )).rows[0].id;
  await seedTenantCapabilities(pool, [tenantId]);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await ensureWorkspaceDefaultRoles(client, tenantId);
    const role = (await client.query<{ id: string }>("SELECT id FROM workspace_roles WHERE workspace_id=$1 AND name='OPERADOR'", [tenantId])).rows[0].id;
    for (const key of ["a", "b"] as const) {
      const user = (await client.query<{ id: string }>(
        "INSERT INTO users(email,password_hash,status) VALUES($1,'x','active') RETURNING id", [`agenda-p1-${key}-${randomUUID()}@test.local`]
      )).rows[0].id;
      members[key] = (await client.query<{ id: string }>(
        "INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at) VALUES($1,$2,$3,'active',now()) RETURNING id", [tenantId, user, role]
      )).rows[0].id;
      await client.query("INSERT INTO scheduling_google_meet_closers(tenant_id,member_id) VALUES($1,$2)", [tenantId, members[key]]);
    }
    await client.query(
      "INSERT INTO scheduling_units(tenant_id,id,name,opening_time,closing_time,operating_days,slot_duration_min,simultaneous_capacity) VALUES($1,'unit','Unit','08:00','23:00',ARRAY[1,2,3,4,5]::smallint[],60,3)",
      [tenantId]
    );
    sessionId = (await client.query<{ id: string }>("INSERT INTO whatsapp_sessions(tenant_id,status) VALUES($1,'connected') RETURNING id", [tenantId])).rows[0].id;
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
  await pool.query("DELETE FROM tenants WHERE id=$1", [tenantId]);
  await pool.end();
});

async function newLead() {
  const phone = `5511${Math.floor(910_000_000 + Math.random() * 89_999_999)}`;
  const leadId = (await pool.query<{ id: string }>(
    "INSERT INTO scheduling_leads(tenant_id,phone,name,source) VALUES($1,$2,'Lead','test') RETURNING id", [tenantId, phone]
  )).rows[0].id;
  await pool.query("INSERT INTO conversations(tenant_id,session_id,contact_phone,contact_name) VALUES($1,$2,$3,'Lead')", [tenantId, sessionId, phone]);
  return leadId;
}

const options = { manual: true, allowExplicitAssignee: true, now: NOW };

describe("auditoria P1 — agenda", () => {
  it("F4: reagendar replaneja os lembretes de confirmação para o novo horário", async () => {
    const leadId = await newLead();
    const appointment = await createAppointment(tenantId, { lead_id: leadId, unidade_id: "unit", start: SLOT_START, assigned_member_id: members.a }, options);
    const repository = new MeetingConfirmationRepository(pool);
    // Agendamentos de outubro/2026: planejados relativos ao relógio real.
    expect(await repository.enqueueForAppointment(appointment.id as string)).toHaveLength(2);
    const newStart = "2026-10-07T18:00:00Z";
    await rescheduleAppointment(tenantId, appointment.id as string, { start: newStart }, { manual: true, now: NOW });
    await repository.enqueueForAppointment(appointment.id as string);
    const rows = (await pool.query<{ moment: string; available_at: Date; status: string }>(
      "SELECT moment,available_at,status FROM scheduling_meeting_confirmation_outbox WHERE appointment_id=$1 ORDER BY available_at", [appointment.id]
    )).rows;
    expect(rows.map((row) => [row.moment, row.available_at.toISOString(), row.status])).toEqual([
      ["duas_horas_antes", "2026-10-07T16:00:00.000Z", "pending"],
      ["quinze_minutos_antes", "2026-10-07T17:45:00.000Z", "pending"]
    ]);
  });

  it("F5: closer da vez com bloqueio recorrente é pulado na seleção automática", async () => {
    await pool.query(
      `INSERT INTO scheduling_attendant_recurring_time_blocks(tenant_id,member_id,start_local_time,end_local_time,weekdays,starts_on,timezone,reason)
       VALUES($1,$2,'10:00','11:00',ARRAY[1]::smallint[],'2026-10-01',$3,'Reunião semanal')`,
      [tenantId, members.a, TZ]
    );
    // Com o cursor em B, a rotação escolheria A em seguida.
    await pool.query(
      `INSERT INTO attendant_assignment_cursors(tenant_id,last_member_id) VALUES($1,$2)
       ON CONFLICT(tenant_id) DO UPDATE SET last_member_id=EXCLUDED.last_member_id`,
      [tenantId, members.b]
    );
    const leadId = await newLead();
    const appointment = await createAppointment(tenantId, { lead_id: leadId, unidade_id: "unit", start: SLOT_START }, { ...options, requireAvailableAttendant: true });
    expect((await pool.query<{ assigned_member_id: string }>(
      "SELECT assigned_member_id FROM scheduling_appointments WHERE id=$1", [appointment.id]
    )).rows[0].assigned_member_id).toBe(members.b);
  });

  it("F5: reagendar para dentro do bloqueio recorrente do closer → 409", async () => {
    const leadId = await newLead();
    const appointment = await createAppointment(tenantId, { lead_id: leadId, unidade_id: "unit", start: "2026-10-06T13:00:00Z", assigned_member_id: members.a }, options);
    await pool.query(
      `INSERT INTO scheduling_attendant_recurring_time_blocks(tenant_id,member_id,start_local_time,end_local_time,weekdays,starts_on,timezone,reason)
       VALUES($1,$2,'10:00','11:00',ARRAY[1]::smallint[],'2026-10-01',$3,'Reunião semanal')`,
      [tenantId, members.a, TZ]
    );
    await expect(rescheduleAppointment(tenantId, appointment.id as string, { start: SLOT_START }, { manual: true, now: NOW }))
      .rejects.toMatchObject({ statusCode: 409 });
  });

  it("F9: reagendar agendamento no_show com outro ativo do mesmo lead → 409", async () => {
    const leadId = await newLead();
    const first = await createAppointment(tenantId, { lead_id: leadId, unidade_id: "unit", start: SLOT_START, assigned_member_id: members.a }, options);
    await pool.query("UPDATE scheduling_appointments SET status='no_show' WHERE id=$1", [first.id]);
    await createAppointment(tenantId, { lead_id: leadId, unidade_id: "unit", start: "2026-10-06T13:00:00Z", assigned_member_id: members.b }, options);
    await expect(rescheduleAppointment(tenantId, first.id as string, { start: "2026-10-07T13:00:00Z" }, { manual: true, now: NOW }))
      .rejects.toMatchObject({ statusCode: 409 });
    const active = await pool.query("SELECT 1 FROM scheduling_appointments WHERE lead_id=$1 AND status IN ('confirmado','reagendado')", [leadId]);
    expect(active.rowCount).toBe(1);
  });

  it("lembrete de 2h de reunião na madrugada seguinte não diz \"hoje\"", async () => {
    const leadId = await newLead();
    // Amanhã 01:00 local: o lembrete de 2h sai às 23:00 de hoje.
    const tomorrow = localDateKey(new Date(Date.now() + 24 * 60 * 60_000), TZ);
    const start = localDateTimeToUtc(tomorrow, "01:00", TZ);
    const appointmentId = (await pool.query<{ id: string }>(
      "INSERT INTO scheduling_appointments(lead_id,tenant_id,unit_id,start_at,end_at,status) VALUES($1,$2,'unit',$3,$4,'confirmado') RETURNING id",
      [leadId, tenantId, start, new Date(start.getTime() + 60 * 60_000)]
    )).rows[0].id;
    const conversation = (await pool.query<{ id: string; contact_phone: string }>(
      "SELECT c.id,c.contact_phone FROM conversations c JOIN scheduling_leads l ON l.phone=c.contact_phone AND l.tenant_id=c.tenant_id WHERE l.id=$1", [leadId]
    )).rows[0];
    const outboxId = (await pool.query<{ id: string }>(
      `INSERT INTO scheduling_meeting_confirmation_outbox(tenant_id,appointment_id,conversation_id,session_id,contact_phone,moment,message_text,available_at)
       VALUES($1,$2,$3,$4,$5,'duas_horas_antes','(a redigir no envio)',now()-interval '1 minute') RETURNING id`,
      [tenantId, appointmentId, conversation.id, sessionId, conversation.contact_phone]
    )).rows[0].id;
    const claimed = await new MeetingConfirmationRepository(pool).claim(outboxId);
    expect(claimed?.messageText).toContain("1h");
    expect(claimed?.messageText).not.toMatch(/\bhoje\b/);
  });

  it("F12: evento de dia inteiro do Google bloqueia o dia LOCAL do closer no reagendamento", async () => {
    await pool.query(
      `INSERT INTO scheduling_calendar_connections(tenant_id,member_id,google_email,refresh_token_encrypted,calendar_id)
       VALUES($1,$2,'a@test.local',$3,'cal-a')`,
      [tenantId, members.a, encryptSecret("refresh-a", config.DATA_ENCRYPTION_KEY)]
    );
    const leadId = await newLead();
    const appointment = await createAppointment(tenantId, { lead_id: leadId, unidade_id: "unit", start: SLOT_START, assigned_member_id: members.a }, options);
    await pool.query(
      // last_synced_at=now(): o vínculo não entra na reconciliação global
      // (calendar-sync roda em paralelo e contaria este vínculo).
      `INSERT INTO scheduling_appointment_calendar_events(appointment_id,tenant_id,connection_id,calendar_id,event_id,last_synced_at)
       SELECT $1,$2,id,calendar_id,'own-event',now() FROM scheduling_calendar_connections WHERE tenant_id=$2 AND member_id=$3`,
      [appointment.id, tenantId, members.a]
    );
    // "Férias" na sexta 09/10 (dia inteiro).
    googleEvents = [{ id: "ferias", start: { date: "2026-10-09" }, end: { date: "2026-10-10" } }];
    // Sexta 21:30 local (sábado 00:30Z) cai nas férias → 409.
    await expect(rescheduleAppointment(tenantId, appointment.id as string, { start: "2026-10-10T00:30:00Z" }, { manual: true, now: NOW }))
      .rejects.toMatchObject({ statusCode: 409 });
    // Quinta 21:30 local (sexta 00:30Z) está livre.
    await expect(rescheduleAppointment(tenantId, appointment.id as string, { start: "2026-10-09T00:30:00Z" }, { manual: true, now: NOW }))
      .resolves.toMatchObject({ id: appointment.id });
  });
});
