// W2B — testes de integração de contact-ops: import CSV (feliz, duplicado
// update/skip/flag, erro por linha), export CSV (filtro, soft delete, tenancy),
// fila aguardando-resposta (aparece/some ao responder, tenancy) e
// onboarding-status derivado.
// app.ts é do orquestrador (fora de escopo): o app de teste registra o plugin
// de rotas + @fastify/cookie, o mesmo conjunto que app.ts usa.
import { randomUUID } from "node:crypto";
import { hash } from "bcryptjs";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureWorkspaceDefaultRoles } from "../src/auth/rbac.js";
import { createSessionToken } from "../src/auth/session.js";
import { registerContactOpsRoutes } from "../src/modules/contact-ops/routes.js";
import { config } from "../src/config.js";

const password = "contact-ops-password";
const pool = new pg.Pool({ connectionString: config.DATABASE_URL });

const app = Fastify({ logger: false });
await app.register(cookie);
await app.register(registerContactOpsRoutes);
app.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) => {
  const status = typeof error.statusCode === "number" ? error.statusCode : 500;
  return reply.status(status).send({ error: error.message });
});
await app.ready();

let tenantA = "";
let tenantB = "";
let ownerA = "";
let ownerB = "";
const emails = new Map<string, string>();
const cookies = new Map<string, string>();

async function loginAs(userId: string): Promise<string> {
  const cached = cookies.get(userId);
  if (cached) return cached;
  const email = emails.get(userId)!;
  const token = await createSessionToken({
    userId,
    tenantId: userId === ownerA ? tenantA : tenantB,
    email,
    isRoot: false,
    rootWorkspaceAccess: false,
    mustChangePassword: false
  });
  const header = `atendon_session=${token}`;
  cookies.set(userId, header);
  return header;
}

async function importCsv(owner: string, csvText: string, mapping: Record<string, unknown>, options?: Record<string, unknown>, filename = "contatos.csv") {
  return app.inject({
    method: "POST",
    url: "/contact-ops/import",
    headers: { cookie: await loginAs(owner) },
    payload: {
      csv_base64: Buffer.from(csvText, "utf8").toString("base64"),
      filename,
      mapping,
      ...(options ? { options } : {})
    }
  });
}

beforeAll(async () => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    tenantA = (await client.query<{ id: string }>("INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id", [`ContactOps A ${randomUUID()}`])).rows[0].id;
    tenantB = (await client.query<{ id: string }>("INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id", [`ContactOps B ${randomUUID()}`])).rows[0].id;
    await ensureWorkspaceDefaultRoles(client, tenantA);
    await ensureWorkspaceDefaultRoles(client, tenantB);
    for (const [tenantId, owner] of [[tenantA, "a"], [tenantB, "b"]] as const) {
      const email = `contact-ops-${owner}-${randomUUID()}@test.local`;
      const user = (await client.query<{ id: string }>("INSERT INTO users(email,password_hash,status) VALUES($1,$2,'active') RETURNING id", [email, await hash(password, 4)])).rows[0];
      await client.query(
        `INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at)
         SELECT $1,$2,id,'active',now() FROM workspace_roles WHERE workspace_id=$1 AND name='OWNER'`,
        [tenantId, user.id]
      );
      emails.set(user.id, email);
      if (owner === "a") ownerA = user.id; else ownerB = user.id;
    }
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

describe("R14 — importação CSV", () => {
  it("importa linhas novas, normaliza telefone, mapeia campos e grava audit", async () => {
    const csvText = "Nome,Telefone,Email,Tags,Origem,Campanha,CPF\nAna Souza,(21) 98888-7777,ana@test.local,Vip; Energia,Campanha Google,verao1,123.456.789-00\nBruno Lima,5531912345678,bruno@test.local,\"Vip,Metadados\",,,\n";
    const response = await importCsv(ownerA, csvText, {
      nome: "Nome", telefone: "Telefone", email: "Email", tags: "Tags", origem: "Origem", campanha: "Campanha",
      custom: { cpf: "CPF" }
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.imported).toBe(2);
    expect(body.errors).toEqual([]);

    const leads = (await pool.query<{ phone: string; name: string; campaign: string | null }>(
      "SELECT phone,name,campaign FROM scheduling_leads WHERE tenant_id=$1 ORDER BY phone", [tenantA]
    )).rows;
    expect(leads.map((lead) => lead.phone)).toEqual(["5521988887777", "5531912345678"]);
    expect(leads[0].name).toBe("Ana Souza");
    expect(leads[0].campaign).toBe("verao1");

    // Email + campo personalizado em lead_custom_values.
    const defs = (await pool.query<{ key: string }>("SELECT key FROM custom_field_defs WHERE tenant_id=$1", [tenantA])).rows;
    expect(defs.map((def) => def.key)).toEqual(expect.arrayContaining(["email", "cpf"]));
    const values = (await pool.query<{ key: string; value: unknown }>(
      `SELECT def.key,value.value FROM lead_custom_values value
       JOIN custom_field_defs def ON def.id=value.field_id AND def.tenant_id=$1`, [tenantA]
    )).rows;
    const byKey = new Map(values.map((item) => [item.key, String(item.value)]));
    // "email" tem uma linha por lead (Ana e Bruno); o Map deduplica pela chave,
    // então a asserção do email olha todas as linhas gravadas.
    expect(values.map((item) => String(item.value))).toContain("ana@test.local");
    expect(byKey.get("cpf")).toBe("123.456.789-00");

    // Etiquetas criadas e atribuídas.
    const tags = (await pool.query<{ name: string }>(
      `SELECT DISTINCT tag.name FROM lead_tag_assignments assignment
       JOIN lead_tags tag ON tag.id=assignment.tag_id WHERE assignment.tenant_id=$1`, [tenantA]
    )).rows;
    expect(tags.map((tag) => tag.name).sort()).toEqual(["Energia", "Metadados", "Vip"]);

    const audit = (await pool.query<{ metadata: Record<string, unknown> }>(
      "SELECT metadata FROM audit_logs WHERE workspace_id=$1 AND action='contact_import'", [tenantA]
    )).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0].metadata).toMatchObject({ imported: 2, filename: "contatos.csv" });
  });

  it("duplicado por telefone: update preserva e preenche, skip reporta, flag não mescla", async () => {
    const csvText = "Nome,Telefone,Email\nAna Souza Nova,(21) 98888-7777,ana-nova@test.local\nOutra Pessoa,(21) 98888-7777,outra@test.local\n";
    const mapping = { nome: "Nome", telefone: "Telefone", email: "Email" };

    const updated = await importCsv(ownerA, csvText, mapping, { on_duplicate: "update" });
    expect(updated.json()).toMatchObject({ imported: 0, updated: 1, skipped: 0, duplicates_flagged: 0 });
    const ana = (await pool.query<{ name: string }>("SELECT name FROM scheduling_leads WHERE tenant_id=$1 AND phone='5521988887777'", [tenantA])).rows[0];
    expect(ana.name).toBe("Ana Souza Nova");

    const skipped = await importCsv(ownerA, csvText, mapping, { on_duplicate: "skip" });
    expect(skipped.json()).toMatchObject({ imported: 0, updated: 0, skipped: 2 });

    const flagged = await importCsv(ownerA, csvText, mapping, { on_duplicate: "flag" });
    expect(flagged.json()).toMatchObject({ imported: 0, updated: 0, skipped: 0, duplicates_flagged: 2 });
  });

  it("erro por linha legível não aborta o arquivo; sem sessão → 401; tenancy isola tenant B", async () => {
    const csvText = "Nome,Telefone\nVálido,11987654321\nInválido,(21) 123\n";
    const response = await importCsv(ownerA, csvText, { nome: "Nome", telefone: "Telefone" });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.imported).toBe(1);
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0]).toMatchObject({ row: 3, field: "linha" });
    expect(body.errors[0].message).toContain("Telefone");

    // Tenant B só enxerga os próprios contatos.
    const responseB = await importCsv(ownerB, "Nome,Telefone\nBeltrano B,21998765432\n", { nome: "Nome", telefone: "Telefone" });
    expect(responseB.json()).toMatchObject({ imported: 1 });
    const leadsB = (await pool.query<{ count: number }>("SELECT count(*)::int count FROM scheduling_leads WHERE tenant_id=$1", [tenantB])).rows;
    expect(leadsB[0].count).toBe(1);

    const semSessao = await app.inject({ method: "POST", url: "/contact-ops/import", payload: {} });
    expect(semSessao.statusCode).toBe(401);
  });
});

describe("R15 — exportação CSV", () => {
  it("exporta filtro, respeita soft delete e não vaza tenant", async () => {
    const leadAna = (await pool.query<{ id: string }>("SELECT id FROM scheduling_leads WHERE tenant_id=$1 AND phone='5521988887777'", [tenantA])).rows[0].id;
    const leadValido = (await pool.query<{ id: string }>("SELECT id FROM scheduling_leads WHERE tenant_id=$1 AND phone='5511987654321'", [tenantA])).rows[0].id;
    await pool.query("UPDATE scheduling_leads SET deleted_at=now() WHERE id=$1", [leadValido]);

    const filtered = await app.inject({
      url: "/contact-ops/export.csv?origem=Campanha%20Google",
      headers: { cookie: await loginAs(ownerA) }
    });
    expect(filtered.statusCode).toBe(200);
    expect(filtered.headers["content-type"]).toContain("text/csv");
    expect(filtered.headers["content-disposition"]).toContain("attachment");
    const lines = filtered.body.trim().split("\n");
    expect(lines[0]).toBe("id,nome,telefone_e164,telefone_display,email,etiquetas,status,origem,campanha,criado_em,cpf,email");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("5521988887777");
    expect(lines[1]).toContain("Ana Souza Nova");
    expect(lines[1]).toContain("Energia, Vip");
    expect(filtered.headers["x-export-truncated"]).toBe("false");

    const ids = await app.inject({
      url: `/contact-ops/export.csv?ids=${leadAna},${leadValido}`,
      headers: { cookie: await loginAs(ownerA) }
    });
    expect(ids.body.trim().split("\n")).toHaveLength(2); // lead na lixeira sai do export por id

    const other = await app.inject({ url: "/contact-ops/export.csv", headers: { cookie: await loginAs(ownerB) } });
    expect(other.body).not.toContain("5521988887777");
    expect(other.body.trim().split("\n")).toHaveLength(2); // cabeçalho + Beltrano B

    const semSessao = await app.inject({ url: "/contact-ops/export.csv" });
    expect(semSessao.statusCode).toBe(401);
  });

  it("células que começam com = + - @ ganham prefixo de apóstrofo (anti CSV injection)", async () => {
    const lead = (await pool.query<{ id: string }>(
      "INSERT INTO scheduling_leads(tenant_id,phone,name,status,source,campaign) VALUES($1,$2,'=1+1 COMANDO','novo','csv-injection','@cmd') RETURNING id",
      [tenantA, `5531${Math.floor(Math.random() * 90_000_000 + 10_000_000)}`]
    )).rows[0].id;
    const response = await app.inject({ url: `/contact-ops/export.csv?ids=${lead}`, headers: { cookie: await loginAs(ownerA) } });
    expect(response.statusCode).toBe(200);
    const dataLine = response.body.trim().split("\n")[1];
    expect(dataLine).toContain("'=1+1 COMANDO"); // nome
    expect(dataLine).toMatch(/'\+5531\d{8}/); // telefone_display (E.164 começa com +)
    expect(dataLine).toContain("'@cmd"); // campanha
    // O id (uuid) nunca é prefixado — só células com fórmula em potencial.
    expect(dataLine).toContain(lead);
  });
});

describe("R17 — fila aguardando resposta", () => {
  it("cliente manda msg → aparece na fila; atendente responde → some", async () => {
    const phone = `5521${Math.floor(Math.random() * 90_000_000 + 10_000_000)}`;
    const sessionId = (await pool.query<{ id: string }>(
      "INSERT INTO whatsapp_sessions(tenant_id,status) VALUES($1,'connected') RETURNING id",
      [tenantA]
    )).rows[0].id;
    const conversationId = (await pool.query<{ id: string }>(
      `INSERT INTO conversations(tenant_id,session_id,contact_phone,contact_name,ai_active,status)
       VALUES($1,$2,$3,'Cliente Fila',false,'open') RETURNING id`,
      [tenantA, sessionId, phone]
    )).rows[0].id;
    await pool.query("INSERT INTO messages(conversation_id,sender,content) VALUES($1,'contact','Olá, preciso de ajuda')", [conversationId]);

    const queueAfterContact = await app.inject({ url: "/contact-ops/awaiting-reply", headers: { cookie: await loginAs(ownerA) } });
    expect(queueAfterContact.statusCode).toBe(200);
    const found = queueAfterContact.json().items.find((item: { conversation_id: string }) => item.conversation_id === conversationId);
    expect(found).toBeTruthy();
    expect(found.contact.phone).toBe(phone);
    expect(found.lead).toBeTruthy();
    expect(found.last_inbound_at).toBeTruthy();

    // Resposta humana no fluxo real grava messages com sender='human'
    // (MessageRepository.sendManualMessageOnce): a fila é derivada, então a
    // remoção acontece no próprio commit da mensagem — sem coluna marcadora.
    await pool.query("INSERT INTO messages(conversation_id,sender,content) VALUES($1,'human','Posso ajudar em algo?')", [conversationId]);
    const queueAfterReply = await app.inject({ url: "/contact-ops/awaiting-reply", headers: { cookie: await loginAs(ownerA) } });
    expect(queueAfterReply.json().items.find((item: { conversation_id: string }) => item.conversation_id === conversationId)).toBeUndefined();
  });

  it("tenancy: dono do tenant B não vê fila do tenant A", async () => {
    const queueB = await app.inject({ url: "/contact-ops/awaiting-reply", headers: { cookie: await loginAs(ownerB) } });
    expect(queueB.json().items.every((item: { contact: { name: string | null } }) => item.contact.name !== "Cliente Fila")).toBe(true);
  });
});

describe("R20 — onboarding-status", () => {
  it("deriva pendências do estado real e reflete canal/equipe/timezone", async () => {
    const before = await app.inject({ url: "/organization/onboarding-status", headers: { cookie: await loginAs(ownerB) } });
    expect(before.statusCode).toBe(200);
    const beforeBody = before.json();
    const byKey = (body: { items: Array<{ key: string; done: boolean; href: string }> }) => new Map(body.items.map((item) => [item.key, item]));
    expect(byKey(beforeBody).get("canal")!.done).toBe(false); // sem sessão conectada
    expect(byKey(beforeBody).get("empresa")!.done).toBe(false); // timezone placeholder 'UTC'
    expect(byKey(beforeBody).get("equipe")!.done).toBe(false); // 1 membro ativo
    // Pipeline novo já nasce com 7 etapas semeadas pelo trigger 0098 → done.
    expect(byKey(beforeBody).get("pipeline")!.done).toBe(true);
    expect(beforeBody.all_done).toBe(false);
    expect(byKey(beforeBody).get("canal")!.href).toBe("/conexao");

    await pool.query("UPDATE tenants SET timezone='America/Sao_Paulo' WHERE id=$1", [tenantB]);
    await pool.query(
      "INSERT INTO whatsapp_sessions(tenant_id,phone_number,status) VALUES($1,'5511900000000','connected')",
      [tenantB]
    );
    const email = `contact-ops-peer-${randomUUID()}@test.local`;
    const peer = (await pool.query<{ id: string }>("INSERT INTO users(email,password_hash,status) VALUES($1,$2,'active') RETURNING id", [email, await hash(password, 4)])).rows[0];
    await pool.query(
      `INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at)
       SELECT $1,$2,id,'active',now() FROM workspace_roles WHERE workspace_id=$1 AND name='OPERADOR'`,
      [tenantB, peer.id]
    );
    const after = await app.inject({ url: "/organization/onboarding-status", headers: { cookie: await loginAs(ownerB) } });
    const afterBody = after.json();
    expect(afterBody.items.every((item: { done: boolean }) => item.done)).toBe(true);
    expect(afterBody.all_done).toBe(true);
  });
});
