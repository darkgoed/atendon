import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureWorkspaceDefaultRoles } from "../src/auth/rbac.js";
import { config } from "../src/config.js";
import {
  createAppointment,
  createQualifiedMeetingAppointment
} from "../src/modules/scheduling/service.js";

/**
 * R1 — o primeiro pedido de confirmação é feito pela IA no turno do
 * agendamento (service.ts grava `contact_confirmation_state` direto no
 * INSERT), então o gate da flag `scheduling_meeting_confirmation_v1` precisa
 * viver na criação do agendamento nascido por IA (sem ator humano), dentro da
 * mesma transação.
 *
 * A IA agenda via `createQualifiedMeetingAppointment`, que exige um closer
 * disponível no pool — por isso o fixture cria usuário OWNER com os papéis
 * padrão do workspace e o insere no pool de closers.
 *
 * Agendamento humano (com ator) não muda: nasce `nao_solicitada` com a flag
 * ligada OU desligada, e o agendamento é criado de qualquer jeito.
 *
 * Isolamento: tenant B (override desligado) não herda a opção de A (ligado).
 */
const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 5 });

const tenants: string[] = [];
const phones: string[] = [];
let phoneSeq = 0;
const nextPhone = () => `551199${String(++phoneSeq).padStart(8, "0")}`;

/** Closer OWNER ativo no pool; o leitor das transações é o próprio service. */
async function setupTenant(flagEnabled: boolean): Promise<{ tenantId: string; unitId: string }> {
  const suffix = randomUUID();
  const tenantId = (await pool.query<{ id: string }>(
    "INSERT INTO tenants(name, slug) VALUES($1,$2) RETURNING id",
    [`ai-confirm-${suffix}`, `ai-confirm-${suffix}`]
  )).rows[0]!.id;
  tenants.push(tenantId);
  const unitId = (await pool.query<{ id: string }>(
    `INSERT INTO scheduling_units(id, tenant_id, name, opening_time, closing_time, operating_days, slot_duration_min, simultaneous_capacity)
     VALUES($1,$2,'Unidade','00:00','23:59',ARRAY[0,1,2,3,4,5,6]::smallint[],60,10) RETURNING id`,
    [randomUUID(), tenantId]
  )).rows[0]!.id;
  await pool.query(
    `INSERT INTO tenant_feature_flag_overrides(tenant_id, flag_key, enabled)
     VALUES($1,'scheduling_meeting_confirmation_v1',$2)
     ON CONFLICT(tenant_id, flag_key) DO UPDATE SET enabled=$2`,
    [tenantId, flagEnabled]
  );
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await ensureWorkspaceDefaultRoles(client, tenantId);
    const user = (await client.query<{ id: string }>(
      "INSERT INTO users(email, password_hash, status) VALUES($1,'x','active') RETURNING id",
      [`ai-confirm-${suffix}@test.local`]
    )).rows[0]!.id;
    const member = (await client.query<{ id: string }>(
      `INSERT INTO workspace_members(workspace_id, user_id, role_id, status, joined_at)
       SELECT $1,$2,id,'active',now() FROM workspace_roles WHERE workspace_id=$1 AND name='OWNER' RETURNING id`,
      [tenantId, user]
    )).rows[0]!.id;
    // availability_status default 'available' (0071_attendant_availability.sql)
    await client.query(
      "INSERT INTO scheduling_google_meet_closers(tenant_id, member_id) VALUES($1,$2)",
      [tenantId, member]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return { tenantId, unitId };
}

async function createLead(tenantId: string, unitId: string): Promise<string> {
  const phone = nextPhone();
  phones.push(phone);
  return (await pool.query<{ id: string }>(
    `INSERT INTO scheduling_leads(tenant_id, phone, name, unit_id, status, source, qualification_stars)
     VALUES($1,$2,'Lead IA',$3,'qualificado','test',5) RETURNING id`,
    [tenantId, phone, unitId]
  )).rows[0]!.id;
}

async function stateOf(appointmentId: string): Promise<{ state: string; requestedAt: Date | null; status: string }> {
  const row = (await pool.query<{
    contact_confirmation_state: string;
    contact_confirmation_requested_at: Date | null;
    status: string;
  }>(
    `SELECT contact_confirmation_state, contact_confirmation_requested_at, status
     FROM scheduling_appointments WHERE id=$1`,
    [appointmentId]
  )).rows[0]!;
  return {
    state: row.contact_confirmation_state,
    requestedAt: row.contact_confirmation_requested_at,
    status: row.status
  };
}

function startIn48h(days = 2): string {
  const start = new Date();
  start.setUTCDate(start.getUTCDate() + days);
  start.setUTCHours(10, 0, 0, 0);
  return start.toISOString();
}

let tenantA = "";
let unitA = "";
let tenantB = "";
let unitB = "";

beforeAll(async () => {
  const a = await setupTenant(true);
  tenantA = a.tenantId;
  unitA = a.unitId;
  const b = await setupTenant(false);
  tenantB = b.tenantId;
  unitB = b.unitId;
});

afterAll(async () => {
  // FKs apontam para tenants com ON DELETE CASCADE; apagar os tenants limpa
  // leads, agendamentos, audit_logs e overrides criados pelos testes.
  await pool.query("DELETE FROM tenants WHERE id=ANY($1::uuid[])", [tenants]);
  await pool.query("DELETE FROM users WHERE email LIKE 'ai-confirm-%@test.local'");
  await pool.end();
});

describe("createQualifiedMeetingAppointment (IA, sem ator) sob scheduling_meeting_confirmation_v1", () => {
  it("com a flag ligada, o agendamento nasce solicitada com requested_at", async () => {
    const leadId = await createLead(tenantA, unitA);
    const appointment = await createQualifiedMeetingAppointment(tenantA, {
      lead_id: leadId,
      unidade_id: unitA,
      start: startIn48h(),
      idempotency_key: `ai-flag-on-${randomUUID()}`
    });
    const persisted = await stateOf(String(appointment.id));
    expect(persisted.state).toBe("solicitada");
    expect(persisted.requestedAt).not.toBeNull();
    expect(persisted.status).toBe("confirmado");
  });

  it("com a flag desligada, nasce nao_solicitada sem pedido e a reunião permanece criada", async () => {
    const leadId = await createLead(tenantB, unitB);
    const appointment = await createQualifiedMeetingAppointment(tenantB, {
      lead_id: leadId,
      unidade_id: unitB,
      start: startIn48h(),
      idempotency_key: `ai-flag-off-${randomUUID()}`
    });
    const persisted = await stateOf(String(appointment.id));
    expect(persisted.state).toBe("nao_solicitada");
    expect(persisted.requestedAt).toBeNull();
    // A opção NÃO desativa a criação do agendamento.
    expect(persisted.status).toBe("confirmado");
  });

  it("agendamento humano (com ator) continua nao_solicitada mesmo com a flag ligada", async () => {
    const leadId = await createLead(tenantA, unitA);
    // Humano (painel) nasce por createAppointment com ator — mesmo INSERT de
    // service.ts:2120, mas com ator: não pode depender da flag.
    const appointment = await createAppointment(tenantA, {
      lead_id: leadId,
      unidade_id: unitA,
      start: startIn48h(),
      idempotency_key: `human-flag-on-${randomUUID()}`
    }, { actor: { userId: (await pool.query<{ user_id: string }>(
      "SELECT user_id FROM workspace_members WHERE workspace_id=$1 LIMIT 1", [tenantA]
    )).rows[0]!.user_id } });
    const persisted = await stateOf(String(appointment.id));
    expect(persisted.state).toBe("nao_solicitada");
    expect(persisted.requestedAt).toBeNull();
  });

  it("isolamento: a decisão de B não depende do override de A", async () => {
    const leadA = await createLead(tenantA, unitA);
    const leadB = await createLead(tenantB, unitB);
    // Dia+3: o closer de A já tem a reunião do primeiro teste em dia+2 e a
    // seleção rejeita sobreposição de horário.
    const on = await createQualifiedMeetingAppointment(tenantA, {
      lead_id: leadA,
      unidade_id: unitA,
      start: startIn48h(3),
      idempotency_key: `iso-a-${randomUUID()}`
    });
    const off = await createQualifiedMeetingAppointment(tenantB, {
      lead_id: leadB,
      unidade_id: unitB,
      start: startIn48h(3),
      idempotency_key: `iso-b-${randomUUID()}`
    });
    // Mesmo momento, tenants distintos: A pede confirmação, B não.
    expect((await stateOf(String(on.id))).state).toBe("solicitada");
    expect((await stateOf(String(off.id))).state).toBe("nao_solicitada");
  });
});
