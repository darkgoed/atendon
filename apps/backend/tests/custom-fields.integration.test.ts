// W1C — Campos personalizados (migration 0170, contrato "Campos personalizados"):
// CRUD com fields.manage, validação de valor por tipo, GET de valores em 1 query,
// tenancy do catálogo e do lead.
import { randomUUID } from "node:crypto";
import { hash } from "bcryptjs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureWorkspaceDefaultRoles } from "../src/auth/rbac.js";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";
import { seedTenantCapabilities } from "./helpers/capability-seed.js";

const password = "fields-password";
const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const app = buildApp();
let tenantA = "";
let tenantB = "";
let ownerA = "";
let ownerB = "";
let operatorA = "";
let leadA = "";
let leadB = "";
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

async function createField(owner: string, payload: Record<string, unknown>) {
  const response = await app.inject({ method: "POST", url: "/organization/custom-fields", headers: { cookie: await loginAs(owner) }, payload });
  expect(response.statusCode).toBe(201);
  return response.json().field;
}

beforeAll(async () => {
  await app.ready();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    tenantA = (await client.query<{ id: string }>("INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id", [`Fields A ${randomUUID()}`])).rows[0].id;
    tenantB = (await client.query<{ id: string }>("INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id", [`Fields B ${randomUUID()}`])).rows[0].id;
    await seedTenantCapabilities(client, [tenantA, tenantB]);
    await ensureWorkspaceDefaultRoles(client, tenantA);
    await ensureWorkspaceDefaultRoles(client, tenantB);
    ownerA = await createUser(client, tenantA, await roleIdOf(client, tenantA, "OWNER"), `fields-a-owner-${randomUUID()}@test.local`);
    operatorA = await createUser(client, tenantA, await roleIdOf(client, tenantA, "OPERADOR"), `fields-a-op-${randomUUID()}@test.local`);
    ownerB = await createUser(client, tenantB, await roleIdOf(client, tenantB, "OWNER"), `fields-b-owner-${randomUUID()}@test.local`);
    // FK scheduling_leads(tenant_id,unit_id) exige unidade real em cada tenant.
    for (const tenant of [tenantA, tenantB]) {
      await client.query(
        `INSERT INTO scheduling_units(tenant_id,id,name,opening_time,closing_time,operating_days,slot_duration_min,simultaneous_capacity)
         VALUES($1,'calls','Calls','00:00','23:59',ARRAY[0,1,2,3,4,5,6]::smallint[],30,100)`,
        [tenant]
      );
    }
    leadA = (await client.query<{ id: string }>(
      "INSERT INTO scheduling_leads(tenant_id,phone,name,unit_id,status,source) VALUES($1,$2,'Lead A','calls','qualificado','fields-test') RETURNING id",
      [tenantA, `5521${Math.floor(Math.random() * 90_000_000 + 10_000_000)}`]
    )).rows[0].id;
    leadB = (await client.query<{ id: string }>(
      "INSERT INTO scheduling_leads(tenant_id,phone,name,unit_id,status,source) VALUES($1,$2,'Lead B','calls','qualificado','fields-test') RETURNING id",
      [tenantB, `5522${Math.floor(Math.random() * 90_000_000 + 10_000_000)}`]
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
  await pool.query("DELETE FROM tenants WHERE id IN ($1,$2)", [tenantA, tenantB]);
  await app.close();
  await pool.end();
});

describe("campos personalizados — CRUD", () => {
  it("cria, lista, edita e remove (fields.manage)", async () => {
    const field = await createField(ownerA, { key: "origem", label: "Origem", type: "text" });
    expect(field.key).toBe("origem");

    const list = await app.inject({ url: "/organization/custom-fields", headers: { cookie: await loginAs(ownerA) } });
    expect(list.statusCode).toBe(200);
    expect(list.json().fields.map((item: { id: string }) => item.id)).toContain(field.id);

    const updated = await app.inject({
      method: "PATCH", url: `/organization/custom-fields/${field.id}`, headers: { cookie: await loginAs(ownerA) },
      payload: { label: "Origem do contato", required: true }
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().field.label).toBe("Origem do contato");
    expect(updated.json().field.required).toBe(true);

    const removed = await app.inject({ method: "DELETE", url: `/organization/custom-fields/${field.id}`, headers: { cookie: await loginAs(ownerA) } });
    expect(removed.statusCode).toBe(200);
    const after = await app.inject({ url: "/organization/custom-fields", headers: { cookie: await loginAs(ownerA) } });
    expect(after.json().fields.map((item: { id: string }) => item.id)).not.toContain(field.id);
  });

  it("key duplicada → 409; select sem opções → 400", async () => {
    await createField(ownerA, { key: "cpf", label: "CPF", type: "text" });
    const duplicate = await app.inject({
      method: "POST", url: "/organization/custom-fields", headers: { cookie: await loginAs(ownerA) },
      payload: { key: "cpf", label: "CPF 2", type: "text" }
    });
    expect(duplicate.statusCode).toBe(409);
    const noOptions = await app.inject({
      method: "POST", url: "/organization/custom-fields", headers: { cookie: await loginAs(ownerA) },
      payload: { label: "Canal", type: "select" }
    });
    expect(noOptions.statusCode).toBe(400);
  });
});

describe("campos personalizados — permissões", () => {
  it("operador: catálogo 403, valores 403; leitura escopada ao caso", async () => {
    expect((await app.inject({ url: "/organization/custom-fields", headers: { cookie: await loginAs(operatorA) } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/organization/custom-fields", headers: { cookie: await loginAs(operatorA) }, payload: { label: "x", type: "text" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "PUT", url: `/organization/leads/${leadA}/custom-values`, headers: { cookie: await loginAs(operatorA) }, payload: { field_id: randomUUID(), value: "x" } })).statusCode).toBe(403);
    // Escopo mine: lead sem atribuição ao operador → 404 (mesmo do tenant);
    // gestor (escopo workspace) lê o mesmo lead → 200.
    const read = await app.inject({ url: `/organization/leads/${leadA}/custom-values`, headers: { cookie: await loginAs(operatorA) } });
    expect(read.statusCode).toBe(404);
    const ownerRead = await app.inject({ url: `/organization/leads/${leadA}/custom-values`, headers: { cookie: await loginAs(ownerA) } });
    expect(ownerRead.statusCode).toBe(200);
  });
});

describe("campos personalizados — escopo de caso (F-02)", () => {
  it("operador mine: lead atribuído a outro membro → 404; gestor → 200", async () => {
    const ownerMember = (await pool.query<{ id: string }>(
      "SELECT id FROM workspace_members WHERE workspace_id=$1 AND user_id=$2", [tenantA, ownerA]
    )).rows[0].id;
    await pool.query("UPDATE scheduling_leads SET assigned_member_id=$2 WHERE id=$1", [leadA, ownerMember]);
    const operatorRead = await app.inject({ url: `/organization/leads/${leadA}/custom-values`, headers: { cookie: await loginAs(operatorA) } });
    expect(operatorRead.statusCode).toBe(404);
    const ownerRead = await app.inject({ url: `/organization/leads/${leadA}/custom-values`, headers: { cookie: await loginAs(ownerA) } });
    expect(ownerRead.statusCode).toBe(200);
    await pool.query("UPDATE scheduling_leads SET assigned_member_id=NULL WHERE id=$1", [leadA]);
  });

  it("operador mine: lead de outro tenant e inexistente → 404; na lixeira → 404", async () => {
    expect((await app.inject({ url: `/organization/leads/${leadB}/custom-values`, headers: { cookie: await loginAs(operatorA) } })).statusCode).toBe(404);
    expect((await app.inject({ url: `/organization/leads/${randomUUID()}/custom-values`, headers: { cookie: await loginAs(operatorA) } })).statusCode).toBe(404);
    await pool.query("UPDATE scheduling_leads SET deleted_at=now(),deleted_by=$2 WHERE id=$1", [leadA, ownerA]);
    expect((await app.inject({ url: `/organization/leads/${leadA}/custom-values`, headers: { cookie: await loginAs(operatorA) } })).statusCode).toBe(404);
    await pool.query("UPDATE scheduling_leads SET deleted_at=NULL,deleted_by=NULL WHERE id=$1", [leadA]);
  });
});

describe("campos personalizados — valores por tipo", () => {
  let numberField = "";
  let currencyField = "";
  let dateField = "";
  let selectField = "";
  let multiselectField = "";
  let booleanField = "";
  let textField = "";

  beforeAll(async () => {
    numberField = (await createField(ownerA, { key: "idade", label: "Idade", type: "number" })).id;
    currencyField = (await createField(ownerA, { key: "orcamento", label: "Orçamento", type: "currency" })).id;
    dateField = (await createField(ownerA, { key: "nascimento", label: "Nascimento", type: "date" })).id;
    selectField = (await createField(ownerA, { key: "canal", label: "Canal", type: "select", options: ["whatsapp", "instagram"] })).id;
    multiselectField = (await createField(ownerA, { key: "interesses", label: "Interesses", type: "multiselect", options: ["praia", "hotel"] })).id;
    booleanField = (await createField(ownerA, { key: "vip", label: "VIP", type: "boolean" })).id;
    textField = (await createField(ownerA, { key: "observacao", label: "Observação", type: "text" })).id;
  });

  async function putValue(fieldId: string, value: unknown) {
    return app.inject({
      method: "PUT", url: `/organization/leads/${leadA}/custom-values`,
      headers: { cookie: await loginAs(ownerA) }, payload: { field_id: fieldId, value }
    });
  }

  it("número/moeda aceitam numérico e rejeitam texto", async () => {
    expect((await putValue(numberField, 42)).statusCode).toBe(200);
    expect((await putValue(currencyField, 1500.55)).statusCode).toBe(200);
    expect((await putValue(numberField, "42")).statusCode).toBe(400);
    expect((await putValue(currencyField, "caro")).statusCode).toBe(400);
  });

  it("data exige ISO", async () => {
    expect((await putValue(dateField, "2026-09-18")).statusCode).toBe(200);
    expect((await putValue(dateField, "2026-09-18T10:00:00Z")).statusCode).toBe(200);
    expect((await putValue(dateField, "18/09/2026")).statusCode).toBe(400);
    expect((await putValue(dateField, "ontem")).statusCode).toBe(400);
  });

  it("select ∈ options; multiselect array ∈ options", async () => {
    expect((await putValue(selectField, "whatsapp")).statusCode).toBe(200);
    expect((await putValue(selectField, "telegram")).statusCode).toBe(400);
    expect((await putValue(multiselectField, ["praia", "hotel"])).statusCode).toBe(200);
    expect((await putValue(multiselectField, ["praia", "casarao"])).statusCode).toBe(400);
    expect((await putValue(multiselectField, "praia")).statusCode).toBe(400);
  });

  it("boolean estrito; text aceita string; null limpa", async () => {
    expect((await putValue(booleanField, true)).statusCode).toBe(200);
    expect((await putValue(booleanField, "sim")).statusCode).toBe(400);
    expect((await putValue(textField, "Cliente prefere tarde")).statusCode).toBe(200);
    const cleared = await putValue(booleanField, null);
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().value).toBeNull();
  });

  it("GET devolve todos os campos em uma leitura (não configurados ficam null)", async () => {
    await putValue(numberField, 30);
    const values = await app.inject({ url: `/organization/leads/${leadA}/custom-values`, headers: { cookie: await loginAs(ownerA) } });
    expect(values.statusCode).toBe(200);
    const byId = new Map<string, { value: unknown }>(values.json().items.map((item: { field_id: string; value: unknown }) => [item.field_id, item]));
    expect(byId.get(numberField)).toMatchObject({ value: 30 });
    // currency foi configurado no teste "número/moeda" deste describe; o valor
    // persistido deve voltar na leitura (R7 — valores salvos). O caso "não
    // configurado fica null" é coberto por booleanField, limpado no teste
    // anterior; o isolamento entre leads/tenants já é coberto negativamente
    // no describe de tenancy abaixo.
    expect(byId.get(currencyField)).toMatchObject({ value: 1500.55 });
    expect(byId.get(booleanField)).toMatchObject({ value: null });
    expect(byId.get(selectField)).toMatchObject({ value: "whatsapp" });
    expect(byId.get(multiselectField)).toMatchObject({ value: ["praia", "hotel"] });
  });
});

describe("campos personalizados — tenancy", () => {
  it("catálogo e leads não vazam entre workspaces", async () => {
    const fieldA = await createField(ownerA, { key: "contrato", label: "Contrato", type: "text" });
    const listB = await app.inject({ url: "/organization/custom-fields", headers: { cookie: await loginAs(ownerB) } });
    expect(listB.json().fields.map((item: { id: string }) => item.id)).not.toContain(fieldA.id);

    const cross = await app.inject({
      method: "PUT", url: `/organization/leads/${leadB}/custom-values`,
      headers: { cookie: await loginAs(ownerB) }, payload: { field_id: fieldA.id, value: "vazou" }
    });
    expect(cross.statusCode).toBe(404);

    const valuesB = await app.inject({ url: `/organization/leads/${leadB}/custom-values`, headers: { cookie: await loginAs(ownerB) } });
    expect(valuesB.json().items.map((item: { field_id: string }) => item.field_id)).not.toContain(fieldA.id);
    const stored = await pool.query("SELECT count(*)::int n FROM lead_custom_values WHERE field_id=$1", [fieldA.id]);
    expect(stored.rows[0].n).toBe(0);
  });

  it("lead de outro tenant → 404", async () => {
    const field = await createField(ownerA, { key: "nota_extra", label: "Nota", type: "text" });
    const crossLead = await app.inject({
      method: "PUT", url: `/organization/leads/${leadB}/custom-values`,
      headers: { cookie: await loginAs(ownerA) }, payload: { field_id: field.id, value: "x" }
    });
    expect(crossLead.statusCode).toBe(404);
  });

  it("lead na lixeira não aceita valores", async () => {
    const field = await createField(ownerA, { key: "pos_trash", label: "Pós lixeira", type: "text" });
    await pool.query("UPDATE scheduling_leads SET deleted_at=now(),deleted_by=$2 WHERE id=$1", [leadA, ownerA]);
    const response = await app.inject({
      method: "PUT", url: `/organization/leads/${leadA}/custom-values`,
      headers: { cookie: await loginAs(ownerA) }, payload: { field_id: field.id, value: "x" }
    });
    expect(response.statusCode).toBe(404);
    await pool.query("UPDATE scheduling_leads SET deleted_at=NULL,deleted_by=NULL WHERE id=$1", [leadA]);
  });
});
