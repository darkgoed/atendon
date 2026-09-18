// W1C — Lixeira de contatos (migration 0171, contrato "Lixeira"):
// DELETE /scheduling/leads/:id virou soft delete; GET /trash (keyset,
// trash.manage), restore e purge (definitivo, reproduz a limpeza do hard delete).
import { randomUUID } from "node:crypto";
import { hash } from "bcryptjs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureWorkspaceDefaultRoles } from "../src/auth/rbac.js";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";

const password = "trash-password";
const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const app = buildApp();
let tenantA = "";
let tenantB = "";
let ownerA = "";
let ownerB = "";
let operatorA = "";
const emails = new Map<string, string>();
const cookies = new Map<string, string>();

async function loginAs(userId: string) {
  const cached = cookies.get(userId);
  if (cached) return cached;
  const email = emails.get(userId)!;
  const response = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password } });
  expect(response.statusCode).toBe(200);
  const cookie = (Array.isArray(response.headers["set-cookie"]) ? response.headers["set-cookie"][0] : response.headers["set-cookie"]!).split(";")[0];
  cookies.set(userId, cookie);
  return cookie;
}

async function createUser(client: pg.PoolClient, tenantId: string, roleId: string, email: string) {
  const user = await client.query<{ id: string }>("INSERT INTO users(email,password_hash,status) VALUES($1,$2,'active') RETURNING id", [email, await hash(password, 4)]);
  await client.query("INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at) VALUES($1,$2,$3,'active',now())", [tenantId, user.rows[0].id, roleId]);
  emails.set(user.rows[0].id, email);
  return user.rows[0].id;
}

async function roleIdOf(client: pg.PoolClient, tenantId: string, name: string) {
  return (await client.query<{ id: string }>("SELECT id FROM workspace_roles WHERE workspace_id=$1 AND name=$2", [tenantId, name])).rows[0].id;
}

async function createLead(tenantId: string, label: string) {
  return (await pool.query<{ id: string }>(
    "INSERT INTO scheduling_leads(tenant_id,phone,name,unit_id,status,source) VALUES($1,$2,$3,'calls','qualificado','trash-test') RETURNING id",
    [tenantId, `5531${Math.floor(Math.random() * 90_000_000 + 10_000_000)}`, label]
  )).rows[0].id;
}

async function listLeadIds(owner: string) {
  const response = await app.inject({ url: "/scheduling/leads", headers: { cookie: await loginAs(owner) } });
  expect(response.statusCode).toBe(200);
  return response.json().leads.map((lead: { id: string }) => lead.id) as string[];
}

beforeAll(async () => {
  await app.ready();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    tenantA = (await client.query<{ id: string }>("INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id", [`Trash A ${randomUUID()}`])).rows[0].id;
    tenantB = (await client.query<{ id: string }>("INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id", [`Trash B ${randomUUID()}`])).rows[0].id;
    await ensureWorkspaceDefaultRoles(client, tenantA);
    await ensureWorkspaceDefaultRoles(client, tenantB);
    ownerA = await createUser(client, tenantA, await roleIdOf(client, tenantA, "OWNER"), `trash-a-owner-${randomUUID()}@test.local`);
    operatorA = await createUser(client, tenantA, await roleIdOf(client, tenantA, "OPERADOR"), `trash-a-op-${randomUUID()}@test.local`);
    ownerB = await createUser(client, tenantB, await roleIdOf(client, tenantB, "OWNER"), `trash-b-owner-${randomUUID()}@test.local`);
    // FK de scheduling_appointments (tenant_id,unit_id) → agendamento do teste
    // de purge precisa de uma unidade real.
    await client.query(
      `INSERT INTO scheduling_units(tenant_id,id,name,opening_time,closing_time,operating_days,slot_duration_min,simultaneous_capacity)
       VALUES($1,'calls','Calls','00:00','23:59',ARRAY[0,1,2,3,4,5,6]::smallint[],30,100)`,
      [tenantA]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});

afterAll(async () => {
  await pool.query("DELETE FROM tenants WHERE id IN ($1,$2)", [tenantA, tenantB]);
  await app.close();
  await pool.end();
});

describe("lixeira — soft delete esconde o contato", () => {
  it("DELETE /scheduling/leads/:id marca deleted_at/deleted_by e some das listas", async () => {
    const leadId = await createLead(tenantA, "Contato para lixeira");
    expect((await listLeadIds(ownerA)).includes(leadId)).toBe(true);

    const deleted = await app.inject({ method: "DELETE", url: `/scheduling/leads/${leadId}`, headers: { cookie: await loginAs(ownerA) } });
    expect(deleted.statusCode).toBe(200);

    expect((await listLeadIds(ownerA)).includes(leadId)).toBe(false);
    expect((await app.inject({ url: `/scheduling/leads/${leadId}`, headers: { cookie: await loginAs(ownerA) } })).statusCode).toBe(404);

    const row = (await pool.query<{ deleted_at: Date | null; deleted_by: string | null }>(
      "SELECT deleted_at,deleted_by FROM scheduling_leads WHERE tenant_id=$1 AND id=$2", [tenantA, leadId]
    )).rows[0];
    expect(row.deleted_at).toBeTruthy();
    expect(row.deleted_by).toBe(ownerA);

    const trash = await app.inject({ url: "/trash", headers: { cookie: await loginAs(ownerA) } });
    expect(trash.statusCode).toBe(200);
    const entry = trash.json().items.find((item: { id: string }) => item.id === leadId);
    expect(entry).toBeTruthy();
    expect(entry.deleted_by).toMatchObject({ id: ownerA });
  });

  it("operador sem leads.delete não remove; sem trash.manage não vê lixeira", async () => {
    const leadId = await createLead(tenantA, "Protegido do operador");
    expect((await app.inject({ method: "DELETE", url: `/scheduling/leads/${leadId}`, headers: { cookie: await loginAs(operatorA) } })).statusCode).toBe(403);
    expect((await app.inject({ url: "/trash", headers: { cookie: await loginAs(operatorA) } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: `/trash/leads/${leadId}/restore`, headers: { cookie: await loginAs(operatorA) } })).statusCode).toBe(403);
    expect((await app.inject({ method: "DELETE", url: `/trash/leads/${leadId}`, headers: { cookie: await loginAs(operatorA) } })).statusCode).toBe(403);
  });
});

describe("lixeira — restore e keyset", () => {
  it("restaurar devolve o contato às listas e limpa a lixeira", async () => {
    const leadId = await createLead(tenantA, "Volta pra lista");
    expect((await app.inject({ method: "DELETE", url: `/scheduling/leads/${leadId}`, headers: { cookie: await loginAs(ownerA) } })).statusCode).toBe(200);
    expect((await listLeadIds(ownerA)).includes(leadId)).toBe(false);

    const restored = await app.inject({ method: "POST", url: `/trash/leads/${leadId}/restore`, headers: { cookie: await loginAs(ownerA) } });
    expect(restored.statusCode).toBe(200);
    expect((await listLeadIds(ownerA)).includes(leadId)).toBe(true);

    const trash = await app.inject({ url: "/trash", headers: { cookie: await loginAs(ownerA) } });
    expect(trash.json().items.find((item: { id: string }) => item.id === leadId)).toBeUndefined();

    const row = (await pool.query<{ deleted_at: Date | null }>(
      "SELECT deleted_at FROM scheduling_leads WHERE tenant_id=$1 AND id=$2", [tenantA, leadId]
    )).rows[0];
    expect(row.deleted_at).toBeNull();

    // Restaurar novamente (não está na lixeira) → 404.
    expect((await app.inject({ method: "POST", url: `/trash/leads/${leadId}/restore`, headers: { cookie: await loginAs(ownerA) } })).statusCode).toBe(404);
  });

  it("keyset pagina a lixeira sem repetir itens", async () => {
    const first = await createLead(tenantA, "Lixo 1");
    const second = await createLead(tenantA, "Lixo 2");
    for (const id of [first, second]) {
      expect((await app.inject({ method: "DELETE", url: `/scheduling/leads/${id}`, headers: { cookie: await loginAs(ownerA) } })).statusCode).toBe(200);
    }
    const page1 = await app.inject({ url: "/trash?limit=1", headers: { cookie: await loginAs(ownerA) } });
    expect(page1.json().page.has_more).toBe(true);
    const ids1 = page1.json().items.map((item: { id: string }) => item.id);
    const page2 = await app.inject({ url: `/trash?limit=1&cursor=${page1.json().page.next_cursor}`, headers: { cookie: await loginAs(ownerA) } });
    const ids2 = page2.json().items.map((item: { id: string }) => item.id);
    expect(ids2.filter((id: string) => ids1.includes(id))).toEqual([]);
  });
});

describe("lixeira — purge definitivo e tenancy", () => {
  it("DELETE /trash/leads/:id apaga de vez lead, agendamentos e registra auditoria", async () => {
    const leadId = await createLead(tenantA, "Será apagado de vez");
    await pool.query(
      "INSERT INTO scheduling_appointments(lead_id,tenant_id,unit_id,start_at,end_at) VALUES($1,$2,'calls',now(),now()+interval '2 hours')",
      [leadId, tenantA]
    );
    expect((await app.inject({ method: "DELETE", url: `/scheduling/leads/${leadId}`, headers: { cookie: await loginAs(ownerA) } })).statusCode).toBe(200);

    const purged = await app.inject({ method: "DELETE", url: `/trash/leads/${leadId}`, headers: { cookie: await loginAs(ownerA) } });
    expect(purged.statusCode).toBe(200);

    expect((await pool.query("SELECT 1 FROM scheduling_leads WHERE tenant_id=$1 AND id=$2", [tenantA, leadId])).rowCount).toBe(0);
    expect((await pool.query("SELECT 1 FROM scheduling_appointments WHERE tenant_id=$1 AND lead_id=$2", [tenantA, leadId])).rowCount).toBe(0);
    expect((await app.inject({ method: "POST", url: `/trash/leads/${leadId}/restore`, headers: { cookie: await loginAs(ownerA) } })).statusCode).toBe(404);

    const audit = await pool.query(
      "SELECT action FROM audit_logs WHERE workspace_id=$1 AND resource_id=$2 AND action IN ('trash.purge','scheduling_lead.delete') ORDER BY action",
      [tenantA, leadId]
    );
    expect(audit.rows.map((row) => row.action).sort()).toEqual(["scheduling_lead.delete", "trash.purge"]);
  });

  it("purge de lead com confirmação de reunião pendente limpa a outbox (0127) sem explodir", async () => {
    const leadId = await createLead(tenantA, "Purge com outbox de reunião");
    const leadPhone = (await pool.query<{ phone: string }>("SELECT phone FROM scheduling_leads WHERE id=$1", [leadId])).rows[0].phone;
    const sessionId = (await pool.query<{ id: string }>(
      "INSERT INTO whatsapp_sessions(tenant_id,status) VALUES($1,'connected') RETURNING id",
      [tenantA]
    )).rows[0].id;
    const appointmentId = (await pool.query<{ id: string }>(
      "INSERT INTO scheduling_appointments(lead_id,tenant_id,unit_id,start_at,end_at) VALUES($1,$2,'calls',now(),now()+interval '1 hour') RETURNING id",
      [leadId, tenantA]
    )).rows[0].id;
    const conversationId = (await pool.query<{ id: string }>(
      "INSERT INTO conversations(tenant_id,session_id,contact_phone,lead_id) VALUES($1,$2,$3,$4) RETURNING id",
      [tenantA, sessionId, leadPhone, leadId]
    )).rows[0].id;
    // Duas confirmações pendentes (momentos distintos) apontando appointment e
    // conversation do lead: FK de conversations na outbox é restritiva.
    await pool.query(
      `INSERT INTO scheduling_meeting_confirmation_outbox
         (tenant_id,appointment_id,conversation_id,session_id,contact_phone,moment,message_text)
       VALUES($1,$2,$3,$4,$5,'pos_agendamento','Confirmando nossa reunião'),
             ($1,$2,$3,$4,$5,'duas_horas_antes','Lembrete da reunião')`,
      [tenantA, appointmentId, conversationId, sessionId, leadPhone]
    );
    expect((await app.inject({ method: "DELETE", url: `/scheduling/leads/${leadId}`, headers: { cookie: await loginAs(ownerA) } })).statusCode).toBe(200);

    const purged = await app.inject({ method: "DELETE", url: `/trash/leads/${leadId}`, headers: { cookie: await loginAs(ownerA) } });
    expect(purged.statusCode).toBe(200);
    expect((await pool.query("SELECT 1 FROM scheduling_meeting_confirmation_outbox WHERE tenant_id=$1 AND (appointment_id=$2 OR conversation_id=$3)", [tenantA, appointmentId, conversationId])).rowCount).toBe(0);
    expect((await pool.query("SELECT 1 FROM scheduling_appointments WHERE tenant_id=$1 AND id=$2", [tenantA, appointmentId])).rowCount).toBe(0);
    expect((await pool.query("SELECT 1 FROM conversations WHERE tenant_id=$1 AND id=$2", [tenantA, conversationId])).rowCount).toBe(0);
    expect((await pool.query("SELECT 1 FROM scheduling_leads WHERE tenant_id=$1 AND id=$2", [tenantA, leadId])).rowCount).toBe(0);
  });

  it("workspace B não vê nem restaura/apaga lixeira de A; auditoria de restore", async () => {
    const leadId = await createLead(tenantA, "Só do A");
    expect((await app.inject({ method: "DELETE", url: `/scheduling/leads/${leadId}`, headers: { cookie: await loginAs(ownerA) } })).statusCode).toBe(200);

    const trashB = await app.inject({ url: "/trash", headers: { cookie: await loginAs(ownerB) } });
    expect(trashB.json().items.find((item: { id: string }) => item.id === leadId)).toBeUndefined();
    expect((await app.inject({ method: "POST", url: `/trash/leads/${leadId}/restore`, headers: { cookie: await loginAs(ownerB) } })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: `/trash/leads/${leadId}`, headers: { cookie: await loginAs(ownerB) } })).statusCode).toBe(404);

    expect((await app.inject({ method: "POST", url: `/trash/leads/${leadId}/restore`, headers: { cookie: await loginAs(ownerA) } })).statusCode).toBe(200);
    const audit = (await pool.query(
      "SELECT 1 FROM audit_logs WHERE workspace_id=$1 AND resource_id=$2 AND action='trash.restore'",
      [tenantA, leadId]
    )).rowCount;
    expect(audit).toBeGreaterThan(0);
  });
});
