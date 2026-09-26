// Integração: guarda de snapshot esperado (concorrência) da adoção
// Google→AtendON via rescheduleAppointment / cancelAppointmentJourney
// (specs/active/google-calendar-team-sync.md). Snapshot desatualizado → 409
// (não 404) e nenhuma mudança em agendamento/lead/jornada; snapshot coerente
// aplica; chamadas legadas sem snapshot continuam funcionando. Banco real,
// sem stubs — nenhum membro conectado, então o Google nunca é chamado.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ensureWorkspaceDefaultRoles } from "../src/auth/rbac.js";
import { config } from "../src/config.js";
import { seedTenantCapabilities } from "./helpers/capability-seed.js";
import { cancelAppointmentJourney } from "../src/modules/commercial-journey/service.js";
import { createAppointment, rescheduleAppointment } from "../src/modules/scheduling/service.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
// Segunda 05/10/2026 — dentro de 08:00-18:00, operating days Mon-Fri (UTC e UTC-3).
const NOW = new Date("2026-10-05T09:00:00Z");
const SLOT_START = "2026-10-05T13:00:00.000Z";
const SLOT_END = "2026-10-05T14:00:00.000Z";
const MOVE_START = "2026-10-05T15:00:00.000Z";
const MOVE_END = "2026-10-05T16:00:00.000Z";
const CREATE_OPTIONS = { manual: true, allowExplicitAssignee: true, now: NOW };
// Snapshot lido do agendamento confirmado antes da escrita.
const MATCHING_SNAPSHOT = { status: "confirmado" as const, start_at: SLOT_START, end_at: SLOT_END };

let tenantId = "";
let memberId = "";

beforeAll(async () => {
  tenantId = (await pool.query<{ id: string }>(
    "INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id",
    [`InboundGuards ${randomUUID()}`]
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
    const sessionId = (await client.query<{ id: string }>(
      "INSERT INTO whatsapp_sessions(tenant_id,status) VALUES($1,'connected') RETURNING id",
      [tenantId]
    )).rows[0].id;
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});

afterAll(async () => {
  await pool.query("DELETE FROM tenants WHERE name LIKE 'InboundGuards %'");
  await pool.end();
});

// Cada teste cria o próprio lead/agenda no MESMO slot: limpa antes do próximo
// para o check de sobreposição do pool de closers não ver agendamentos alheios.
afterEach(async () => {
  await pool.query("DELETE FROM scheduling_appointments WHERE tenant_id=$1", [tenantId]);
  await pool.query("DELETE FROM system_alerts WHERE tenant_id=$1", [tenantId]);
  await pool.query("DELETE FROM conversations WHERE tenant_id=$1", [tenantId]);
  await pool.query("DELETE FROM scheduling_leads WHERE tenant_id=$1", [tenantId]);
});

async function newAppointment(): Promise<{ appointmentId: string; leadId: string }> {
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
    { lead_id: leadId, unidade_id: "unit", start: SLOT_START, assigned_member_id: memberId },
    CREATE_OPTIONS
  );
  return { appointmentId: appointment.id as string, leadId };
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
  return JSON.stringify({ appointment, lead, events });
}

async function rejection(call: Promise<unknown>): Promise<{ statusCode: number; message: string }> {
  return await call.then(
    () => { throw new Error("chamada deveria recusar"); },
    (error: { statusCode?: number; message?: string }) => ({ statusCode: error.statusCode ?? 0, message: error.message ?? "" })
  );
}

describe("calendar inbound snapshot guards (google-calendar-team-sync)", () => {
  it("snapshot coerente: reschedule aplica horário e duração exatos", async () => {
    const { appointmentId, leadId } = await newAppointment();
    const result = await rescheduleAppointment(
      tenantId,
      appointmentId,
      { start: MOVE_START, end: MOVE_END, unidade_id: "unit" },
      { manual: true, now: NOW, expectedSnapshot: MATCHING_SNAPSHOT }
    );
    expect(result.status).toBe("confirmado");
    expect((result.start as Date).toISOString()).toBe(MOVE_START);
    expect((result.end as Date).toISOString()).toBe(MOVE_END);
    expect((await pool.query<{ status: string }>("SELECT status FROM scheduling_leads WHERE id=$1", [leadId])).rows[0].status)
      .toBe("agendado");
  });

  it("snapshot desatualizado após edição do painel: 409 e nada muda", async () => {
    const { appointmentId, leadId } = await newAppointment();
    // Edição concorrente do painel (legado, sem snapshot).
    await rescheduleAppointment(
      tenantId,
      appointmentId,
      { start: MOVE_START, end: MOVE_END, unidade_id: "unit" },
      { manual: true, now: NOW }
    );
    const before = await stateSnapshot(leadId, appointmentId);
    // Chamador Google com snapshot lido antes da edição do painel → recusado.
    const error = await rejection(rescheduleAppointment(
      tenantId,
      appointmentId,
      { start: SLOT_START, unidade_id: "unit" },
      { manual: true, now: NOW, expectedSnapshot: MATCHING_SNAPSHOT }
    ));
    expect(error.statusCode).toBe(409);
    expect(error.message).toContain("alterado por outra operação");
    expect(await stateSnapshot(leadId, appointmentId)).toBe(before);
  });

  it("status divergente em linha ativa: 409 do guarda, não do fluxo legado", async () => {
    const { appointmentId, leadId } = await newAppointment();
    const before = await stateSnapshot(leadId, appointmentId);
    // Status esperado 'reagendado' em linha ativa 'confirmado': só o guarda recusa.
    const error = await rejection(rescheduleAppointment(
      tenantId,
      appointmentId,
      { start: MOVE_START, unidade_id: "unit" },
      { manual: true, now: NOW, expectedSnapshot: { ...MATCHING_SNAPSHOT, status: "reagendado" } }
    ));
    expect(error.statusCode).toBe(409);
    expect(error.message).toContain("alterado por outra operação");
    expect(await stateSnapshot(leadId, appointmentId)).toBe(before);
  });

  it("cancelamento com snapshot coerente: cancela e move jornada para follow_up", async () => {
    const { appointmentId, leadId } = await newAppointment();
    const input = {
      disposition: "recover" as const,
      next_action: "Retomar reunião",
      next_action_at: new Date(NOW.getTime()+86_400_000).toISOString()
    };
    const result = await cancelAppointmentJourney(tenantId, appointmentId, input, { userId: null }, undefined, { expectedSnapshot: MATCHING_SNAPSHOT });
    expect(result.appointment.status).toBe("cancelado");
    const lead = (await pool.query<{ status: string; recovery_required: boolean; recovery_member_id: string | null }>(
      "SELECT status,recovery_required,recovery_member_id FROM scheduling_leads WHERE id=$1",
      [leadId]
    )).rows[0];
    expect(lead.status).toBe("follow_up");
    expect(lead.recovery_required).toBe(true);
    expect(lead.recovery_member_id).toBe(memberId);
  });

  it("cancelamento com snapshot desatualizado: 409 e jornada intacta", async () => {
    const { appointmentId, leadId } = await newAppointment();
    const before = await stateSnapshot(leadId, appointmentId);
    const input = {
      disposition: "recover" as const,
      next_action: "Retomar reunião",
      next_action_at: new Date(NOW.getTime()+86_400_000).toISOString()
    };
    // Snapshot lido antes de edição concorrente do painel → recusado.
    const error = await rejection(cancelAppointmentJourney(
      tenantId,
      appointmentId,
      input,
      { userId: null },
      undefined,
      { expectedSnapshot: { ...MATCHING_SNAPSHOT, start_at: MOVE_START } }
    ));
    expect(error.statusCode).toBe(409);
    expect(error.message).toContain("alterado por outra operação");
    expect(await stateSnapshot(leadId, appointmentId)).toBe(before);
  });

  it("legado: cancelamento sem snapshot continua funcionando", async () => {
    const { appointmentId, leadId } = await newAppointment();
    const result = await cancelAppointmentJourney(tenantId, appointmentId, {
      disposition: "recover",
      next_action: "Retomar reunião",
      next_action_at: new Date(NOW.getTime()+86_400_000).toISOString()
    }, { userId: null });
    expect(result.appointment.status).toBe("cancelado");
    expect((await pool.query<{ status: string }>("SELECT status FROM scheduling_leads WHERE id=$1", [leadId])).rows[0].status)
      .toBe("follow_up");
  });
});
