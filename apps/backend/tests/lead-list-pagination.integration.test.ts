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
let foreignTenantId = "";
let sessionId = "";
let foreignSessionId = "";
let cookie = "";
let testEmails: string[] = [];

const TIE_UPDATED_AT = "2026-01-15T12:00:00.000Z";

async function createLead(tenant: string, phone: string, updatedAt: string) {
  return (await pool.query<{ id: string }>(
    `INSERT INTO scheduling_leads(tenant_id,phone,source,name,updated_at)
     VALUES($1,$2,'whatsapp',$3,$4) RETURNING id`,
    [tenant, phone, `Lead ${phone}`, updatedAt]
  )).rows[0].id;
}

async function createConversation(tenant: string, session: string, phone: string, lastMessageAt: string) {
  return (await pool.query<{ id: string }>(
    `INSERT INTO conversations(tenant_id,session_id,contact_phone,last_message_at)
     VALUES($1,$2,$3,$4) RETURNING id`,
    [tenant, session, phone, lastMessageAt]
  )).rows[0].id;
}

beforeAll(async () => {
  await app.ready();
  tenantId = (await pool.query<{ id: string }>("INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id", [`Lead pagination ${randomUUID()}`])).rows[0].id;
  foreignTenantId = (await pool.query<{ id: string }>("INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id", [`Lead pagination foreign ${randomUUID()}`])).rows[0].id;
  await seedTenantCapabilities(pool, [tenantId, foreignTenantId]);
  sessionId = (await pool.query<{ id: string }>("INSERT INTO whatsapp_sessions(tenant_id,status) VALUES($1,'connected') RETURNING id", [tenantId])).rows[0].id;
  foreignSessionId = (await pool.query<{ id: string }>("INSERT INTO whatsapp_sessions(tenant_id,status) VALUES($1,'connected') RETURNING id", [foreignTenantId])).rows[0].id;
  const email = `lead-pagination-${randomUUID()}@test.local`;
  const password = "lead-pagination-password";
  testEmails = [email];
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await ensureWorkspaceDefaultRoles(client, tenantId);
    const passwordHash = await hash(password, 4);
    const user = await client.query<{ id: string }>("INSERT INTO users(email,password_hash,status) VALUES($1,$2,'active') RETURNING id", [email, passwordHash]);
    await client.query(
      "INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at) SELECT $1,$2,id,'active',now() FROM workspace_roles WHERE workspace_id=$1 AND name='OWNER'",
      [tenantId, user.rows[0].id]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  const login = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password } });
  cookie = (Array.isArray(login.headers["set-cookie"]) ? login.headers["set-cookie"][0] : login.headers["set-cookie"]!).split(";")[0];

  // Tenant under test: 7 leads. Two of them share the same updated_at so the
  // (updated_at, id) keyset tiebreak is exercised.
  await createLead(tenantId, "5511900000001", "2026-01-10T10:00:00.000Z");
  await createLead(tenantId, "5511900000002", "2026-01-11T10:00:00.000Z");
  await createLead(tenantId, "5511900000003", TIE_UPDATED_AT);
  await createLead(tenantId, "5511900000004", TIE_UPDATED_AT);
  await createLead(tenantId, "5511900000005", "2026-01-12T10:00:00.000Z");
  await createLead(tenantId, "5511900000006", "2026-01-13T10:00:00.000Z");
  await createLead(tenantId, "5511900000007", "2026-01-14T10:00:00.000Z");
  // Foreign tenant rows must never leak into the tenant's pages.
  await createLead(foreignTenantId, "5521900000001", "2026-01-20T10:00:00.000Z");
  await createLead(foreignTenantId, "5521900000002", "2026-01-21T10:00:00.000Z");
});

afterAll(async () => {
  await pool.query("DELETE FROM tenants WHERE id=ANY($1::uuid[])", [[tenantId, foreignTenantId]]);
  await pool.query("DELETE FROM users WHERE email=ANY($1::text[])", [testEmails]);
  await app.close();
  await pool.end();
});

describe("GET /scheduling/leads keyset pagination", () => {
  it("retorna total, has_more=false e cursor nulo quando cabe em uma página", async () => {
    const response = await app.inject({ method: "GET", url: "/scheduling/leads", headers: { cookie } });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.leads).toHaveLength(7);
    expect(body.total).toBe(7);
    expect(body.page).toMatchObject({ limit: 50, has_more: false, next_cursor: null });
    for (const lead of body.leads) expect(lead.id).toBeDefined();
  });

  it("pagina por cursor sem repetir nem pular leads, inclusive com updated_at empatado", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    let firstPageTotal: number | null = null;
    while (pages < 10) {
      const url = cursor ? `/scheduling/leads?limit=2&cursor=${encodeURIComponent(cursor)}` : "/scheduling/leads?limit=2";
      const response = await app.inject({ method: "GET", url, headers: { cookie } });
      expect(response.statusCode).toBe(200);
      // Anotação quebra a inferência circular url←cursor←body←response←url (TS7022).
      const body = response.json() as { total: number; leads: Array<{ id: string; tenant: string }>; page: { has_more: boolean; next_cursor: string | null } };
      firstPageTotal ??= body.total;
      expect(body.total).toBe(7);
      for (const lead of body.leads) {
        expect(lead.tenant).toBe(tenantId);
        seen.push(lead.id);
      }
      pages += 1;
      if (!body.page.has_more) {
        expect(body.page.next_cursor).toBeNull();
        break;
      }
      expect(body.page.next_cursor).toBeTypeOf("string");
      cursor = body.page.next_cursor;
    }
    expect(pages).toBe(4);
    expect(firstPageTotal).toBe(7);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toHaveLength(7);
  });

  it("ordena por updated_at desc com desempate por id", async () => {
    const response = await app.inject({ method: "GET", url: "/scheduling/leads?limit=3", headers: { cookie } });
    const body = response.json();
    const timestamps = body.leads.map((lead: { atualizado_em: string }) => lead.atualizado_em);
    for (let index = 1; index < timestamps.length; index += 1) {
      expect(new Date(timestamps[index - 1]).getTime()).toBeGreaterThanOrEqual(new Date(timestamps[index]).getTime());
    }
  });

  it("rejeita cursor inválido e limita o tamanho da página", async () => {
    const badCursor = await app.inject({ method: "GET", url: "/scheduling/leads?cursor=!!!nao-base64url!!!", headers: { cookie } });
    expect(badCursor.statusCode).toBe(400);
    const tooBig = await app.inject({ method: "GET", url: "/scheduling/leads?limit=1000", headers: { cookie } });
    expect(tooBig.statusCode).toBe(400);
  });

  it("isola tenants: nenhum lead estrangeiro aparece", async () => {
    const response = await app.inject({ method: "GET", url: "/scheduling/leads?limit=200", headers: { cookie } });
    const body = response.json();
    expect(body.total).toBe(7);
    for (const lead of body.leads) expect(lead.tenant).toBe(tenantId);
  });
});

describe("GET /conversations keyset pagination", () => {
  it("pagina a lista por cursor mantendo total coerente e isolamento de tenant", async () => {
    for (let index = 1; index <= 4; index += 1) {
      await createConversation(tenantId, sessionId, `551191111000${index}`, `2026-02-0${index}T10:00:00.000Z`);
    }
    await createConversation(foreignTenantId, foreignSessionId, "5521911110001", "2026-02-05T10:00:00.000Z");
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let pages = 0; pages < 10; pages += 1) {
      const url = cursor ? `/conversations?filter=all&limit=2&before=${encodeURIComponent(cursor)}` : "/conversations?filter=all&limit=2";
      const response = await app.inject({ method: "GET", url, headers: { cookie } });
      expect(response.statusCode).toBe(200);
      // Anotação quebra a inferência circular url←cursor←body←response←url (TS7022).
      const body = response.json() as { conversations: Array<{ id: string }>; page: { has_more: boolean; next_cursor: string | null } };
      for (const conversation of body.conversations) seen.push(conversation.id);
      if (!body.page.has_more) {
        expect(body.page.next_cursor).toBeNull();
        break;
      }
      cursor = body.page.next_cursor;
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toHaveLength(4);
    const order = await app.inject({ method: "GET", url: "/conversations?filter=all&limit=50", headers: { cookie } });
    const body = order.json();
    const timestamps = body.conversations.map((conversation: { last_message_at: string }) => conversation.last_message_at);
    for (let index = 1; index < timestamps.length; index += 1) {
      expect(new Date(timestamps[index - 1]).getTime()).toBeGreaterThanOrEqual(new Date(timestamps[index]).getTime());
    }
  });

  it("rejeita cursor inválido na listagem de conversas", async () => {
    const response = await app.inject({ method: "GET", url: "/conversations?filter=all&before=%%%invalido%%%", headers: { cookie } });
    expect(response.statusCode).toBe(400);
  });
});
