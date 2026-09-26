// Exclusão definitiva (removeAppointment): o FK CASCADE apagaria o vínculo do
// evento do Google e o outbox de sync, órfãs remotas sem `delete` enfileirado.
// Bloqueia (409) com outbox claimed (mesmo expirado) ou vínculo vivo
// (connection_id NOT NULL). Vínculo órfão (conexão desconectada, 0185 SET NULL)
// nunca é removido pelo worker ('conflict' terminal): bloquear para sempre
// prende o agendamento — cancelado+órfão sem claim → exclui (200); ativo+órfão
// → 409. Sem vínculo e sem claim, exclui (200) — agendamento nunca sincronizado.
import { randomUUID } from "node:crypto";
import { hash } from "bcryptjs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureWorkspaceDefaultRoles } from "../src/auth/rbac.js";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";
import { seedTenantCapabilities } from "./helpers/capability-seed.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const app = buildApp();
let tenantId = "";
let cookie = "";
let sequence = 920_000_000;
const phone = () => `5511${++sequence}`;

beforeAll(async () => {
  await app.ready();
  tenantId = (await pool.query<{ id: string }>("INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id", [`HardRemove ${randomUUID()}`])).rows[0].id;
  await seedTenantCapabilities(pool, [tenantId]);
  const ownerEmail = `hard-remove-owner-${randomUUID()}@test.local`;
  const password = "hard-remove-password";
  const passwordHash = await hash(password, 4);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await ensureWorkspaceDefaultRoles(client, tenantId);
    const roles = await client.query<{ id: string; name: string }>("SELECT id,name FROM workspace_roles WHERE workspace_id=$1", [tenantId]);
    const ownerRole = roles.rows.find((role) => role.name === "OWNER")!.id;
    const owner = await client.query<{ id: string }>("INSERT INTO users(email,password_hash,status) VALUES($1,$2,'active') RETURNING id", [ownerEmail, passwordHash]);
    await client.query("INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at) VALUES($1,$2,$3,'active',now())", [tenantId, owner.rows[0].id, ownerRole]);
    await client.query("INSERT INTO scheduling_units(tenant_id,id,name,opening_time,closing_time,operating_days,simultaneous_capacity) VALUES($1,'unit','Unit','08:00','18:00',ARRAY[1,2,3,4,5]::smallint[],3)", [tenantId]);
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  const login = await app.inject({ method: "POST", url: "/auth/login", payload: { email: ownerEmail, password } });
  cookie = (Array.isArray(login.headers["set-cookie"]) ? login.headers["set-cookie"][0] : login.headers["set-cookie"]!).split(";")[0];
});

afterAll(async () => {
  await pool.query("DELETE FROM tenants WHERE id=$1", [tenantId]);
  await app.close();
  await pool.end();
});

async function createAppointment() {
  const lead = (await pool.query<{ id: string }>(
    "INSERT INTO scheduling_leads(tenant_id,phone,name,source) VALUES($1,$2,'Hard remove','test') RETURNING id",
    [tenantId, phone()]
  )).rows[0].id;
  // O gatilho 0189 enfileira 'upsert' não-claimed no outbox no INSERT.
  return (await pool.query<{ id: string }>(
    `INSERT INTO scheduling_appointments(lead_id,tenant_id,unit_id,start_at,end_at,status)
     VALUES($1,$2,'unit',now()+interval '1 day',now()+interval '1 day 1 hour','confirmado') RETURNING id`,
    [lead, tenantId]
  )).rows[0].id;
}

const memberId = () =>
  (pool.query<{ id: string }>("SELECT id FROM workspace_members WHERE workspace_id=$1", [tenantId])).then(
    (r) => r.rows[0].id
  );

async function createConnection() {
  return (
    await pool.query<{ id: string }>(
      `INSERT INTO scheduling_calendar_connections(tenant_id,member_id,google_email,refresh_token_encrypted)
       VALUES($1,$2,'hard-remove@test.local','enc') RETURNING id`,
      [tenantId, await memberId()]
    )
  ).rows[0].id;
}

async function linkAppointment(appointment: string, connectionId: string | null) {
  await pool.query(
    `INSERT INTO scheduling_appointment_calendar_events(appointment_id,tenant_id,connection_id,calendar_id,event_id)
     VALUES($1,$2,$3,'calendario@test.local',$4)`,
    [appointment, tenantId, connectionId, `evt-${appointment}`]
  );
}

const cancel = (appointment: string) =>
  pool.query("UPDATE scheduling_appointments SET status='cancelado' WHERE id=$1", [appointment]);

const remove = (appointment: string) =>
  app.inject({ method: "DELETE", url: `/scheduling/appointments/${appointment}/remove`, headers: { cookie } });

describe("appointment hard remove", () => {
  it("bloqueia a exclusão definitiva quando há vínculo de evento do Google", async () => {
    const appointment = await createAppointment();
    await pool.query(
      `INSERT INTO scheduling_appointment_calendar_events(appointment_id,tenant_id,calendar_id,event_id)
       VALUES($1,$2,'calendario@test.local','evt-hard-remove')`,
      [appointment, tenantId]
    );

    const response = await app.inject({
      method: "DELETE",
      url: `/scheduling/appointments/${appointment}/remove`,
      headers: { cookie }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatch(/sincronização da agenda/i);
    expect((await pool.query("SELECT 1 FROM scheduling_appointments WHERE id=$1", [appointment])).rows).toHaveLength(1);
  });

  it("bloqueia com outbox claimed mesmo expirado — o worker seguinte recupera", async () => {
    const appointment = await createAppointment();
    await pool.query(
      "UPDATE scheduling_calendar_sync_outbox SET claimed_at=now()-interval '2 hours' WHERE appointment_id=$1 AND tenant_id=$2",
      [appointment, tenantId]
    );

    const response = await app.inject({
      method: "DELETE",
      url: `/scheduling/appointments/${appointment}/remove`,
      headers: { cookie }
    });

    expect(response.statusCode).toBe(409);
    expect((await pool.query("SELECT 1 FROM scheduling_appointments WHERE id=$1", [appointment])).rows).toHaveLength(1);
  });

  it("exclui agendamento sem vínculo nem claim, drenando o outbox não-claimed", async () => {
    const appointment = await createAppointment();

    const response = await app.inject({
      method: "DELETE",
      url: `/scheduling/appointments/${appointment}/remove`,
      headers: { cookie }
    });

    expect(response.statusCode).toBe(200);
    expect((await pool.query("SELECT 1 FROM scheduling_appointments WHERE id=$1", [appointment])).rows).toHaveLength(0);
    expect((await pool.query("SELECT 1 FROM scheduling_calendar_sync_outbox WHERE appointment_id=$1 AND tenant_id=$2", [appointment, tenantId])).rows).toHaveLength(0);
  });

  it("permite excluir cancelado com vínculo órfão (conexão desconectada) e outbox sem claim", async () => {
    const appointment = await createAppointment();
    const connection = await createConnection();
    await linkAppointment(appointment, connection);
    // Desconexão (0185): DELETE na conexão deixa o vínculo órfão (SET NULL).
    await pool.query("DELETE FROM scheduling_calendar_connections WHERE id=$1 AND tenant_id=$2", [connection, tenantId]);
    await cancel(appointment);
    await pool.query(
      "UPDATE scheduling_calendar_sync_outbox SET claimed_at=NULL WHERE appointment_id=$1 AND tenant_id=$2",
      [appointment, tenantId]
    );

    const response = await remove(appointment);

    expect(response.statusCode).toBe(200);
    expect((await pool.query("SELECT 1 FROM scheduling_appointments WHERE id=$1", [appointment])).rows).toHaveLength(0);
  });

  it("bloqueia agendamento ativo com vínculo órfão — só cancelado passa", async () => {
    const appointment = await createAppointment();
    const connection = await createConnection();
    await linkAppointment(appointment, connection);
    await pool.query("DELETE FROM scheduling_calendar_connections WHERE id=$1 AND tenant_id=$2", [connection, tenantId]);

    const response = await remove(appointment);

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatch(/sincronização da agenda/i);
    expect((await pool.query("SELECT 1 FROM scheduling_appointments WHERE id=$1", [appointment])).rows).toHaveLength(1);
  });

  it("bloqueia vínculo vivo (conexão existente) mesmo cancelado — worker ainda pode apagar", async () => {
    const appointment = await createAppointment();
    const connection = await createConnection();
    await linkAppointment(appointment, connection);
    await cancel(appointment);
    await pool.query(
      "UPDATE scheduling_calendar_sync_outbox SET claimed_at=NULL WHERE appointment_id=$1 AND tenant_id=$2",
      [appointment, tenantId]
    );

    const response = await remove(appointment);

    expect(response.statusCode).toBe(409);
    expect((await pool.query("SELECT 1 FROM scheduling_appointments WHERE id=$1", [appointment])).rows).toHaveLength(1);
  });
});
