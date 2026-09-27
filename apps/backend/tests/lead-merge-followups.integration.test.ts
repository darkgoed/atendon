// Auditoria w2 (merge de contatos): depois do merge, o source fica
// soft-deleted com o próprio telefone. Toda busca por telefone precisa chegar
// ao principal (C1); merge/preflight respeitam o escopo do caso (C12); e o
// source mesclado não volta da lixeira como contato fantasma (C13).
import { randomUUID } from "node:crypto";
import { hash } from "bcryptjs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureWorkspaceDefaultRoles } from "../src/auth/rbac.js";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";
import { transferCaseAssignment } from "../src/modules/assignments/service.js";
import { MessageRepository } from "../src/modules/messages/repository.js";
import { mergeLeads } from "../src/modules/organization/lead-merge.js";
import { findLeadByPhone, upsertLead } from "../src/modules/scheduling/service.js";
import { seedTenantCapabilities } from "./helpers/capability-seed.js";

const password = "merge-followups-password";
const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const app = buildApp();
let tenantId = "";
let sessionId = "";
let otherSessionId = "";
let ownerId = "";
let operatorId = "";
let ownerMemberId = "";
let operatorMemberId = "";
const emails = new Map<string, string>();
let phoneSequence = Number(Date.now().toString().slice(-6));
const nextPhone = () => `553197${String(++phoneSequence).slice(-6).padStart(6, "0")}`;

async function loginAs(userId: string) {
  const response = await app.inject({ method: "POST", url: "/auth/login", payload: { email: emails.get(userId), password } });
  expect(response.statusCode).toBe(200);
  const header = response.headers["set-cookie"];
  return (Array.isArray(header) ? header[0] : header!).split(";")[0];
}

async function createUser(client: pg.PoolClient, role: string) {
  const email = `merge-followups-${role.toLowerCase()}-${randomUUID()}@test.local`;
  const user = await client.query<{ id: string }>(
    "INSERT INTO users(email,password_hash,status) VALUES($1,$2,'active') RETURNING id",
    [email, await hash(password, 4)]
  );
  const member = await client.query<{ id: string }>(
    `INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at)
     SELECT $1,$2,id,'active',now() FROM workspace_roles WHERE workspace_id=$1 AND name=$3
     RETURNING id`,
    [tenantId, user.rows[0].id, role]
  );
  emails.set(user.rows[0].id, email);
  return { userId: user.rows[0].id, memberId: member.rows[0].id };
}

async function createLead(phone: string, assignedMemberId: string | null = null) {
  return (await pool.query<{ id: string }>(
    `INSERT INTO scheduling_leads(tenant_id,phone,name,status,source,assigned_member_id)
     VALUES($1,$2,$3,'em_atendimento','merge-followups',$4) RETURNING id`,
    [tenantId, phone, `Lead ${phone}`, assignedMemberId]
  )).rows[0].id;
}

async function mergedPair() {
  const sourcePhone = nextPhone();
  const targetPhone = nextPhone();
  const target = await createLead(targetPhone, ownerMemberId);
  const source = await createLead(sourcePhone, ownerMemberId);
  const conversation = (await pool.query<{ id: string }>(
    `INSERT INTO conversations(tenant_id,session_id,contact_phone,contact_name,status,lead_id,assigned_user_id)
     VALUES($1,$2,$3,'Contato origem','open',$4,$5) RETURNING id`,
    [tenantId, sessionId, sourcePhone, source, ownerId]
  )).rows[0].id;
  await mergeLeads(tenantId, { sourceId: source, targetId: target, confirmations: { different_phone: true } }, {
    userId: ownerId,
    actorScope: "workspace"
  });
  return { source, target, sourcePhone, targetPhone, conversation };
}

beforeAll(async () => {
  await app.ready();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    tenantId = (await client.query<{ id: string }>(
      "INSERT INTO tenants(name,status,timezone) VALUES($1,'active','UTC') RETURNING id",
      [`Merge followups ${randomUUID()}`]
    )).rows[0].id;
    await seedTenantCapabilities(client, [tenantId]);
    await ensureWorkspaceDefaultRoles(client, tenantId);
    ({ userId: ownerId, memberId: ownerMemberId } = await createUser(client, "OWNER"));
    ({ userId: operatorId, memberId: operatorMemberId } = await createUser(client, "OPERADOR"));
    await client.query(
      `INSERT INTO scheduling_google_meet_closers(tenant_id,member_id,availability_status)
       VALUES($1,$2,'available'),($1,$3,'available')`,
      [tenantId, ownerMemberId, operatorMemberId]
    );
    sessionId = (await client.query<{ id: string }>(
      "INSERT INTO whatsapp_sessions(tenant_id,label,is_primary,status) VALUES($1,'Principal',true,'connected') RETURNING id",
      [tenantId]
    )).rows[0].id;
    otherSessionId = (await client.query<{ id: string }>(
      "INSERT INTO whatsapp_sessions(tenant_id,label,is_primary,status) VALUES($1,'Segunda',false,'connected') RETURNING id",
      [tenantId]
    )).rows[0].id;
    await client.query(
      "INSERT INTO agent_configs(tenant_id,system_prompt,ai_model) VALUES($1,'prompt merge','test/model')",
      [tenantId]
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
  await pool.query("DELETE FROM tenants WHERE id=$1", [tenantId]);
  await app.close();
  await pool.end();
});

describe("C1 — busca por telefone depois do merge chega ao principal", () => {
  it("transferência do principal leva junto a conversa do telefone mesclado", async () => {
    const { target, conversation } = await mergedPair();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await transferCaseAssignment(client, {
        tenantId,
        selector: { leadId: target },
        targetMemberId: operatorMemberId,
        actor: { userId: ownerId, actorScope: "workspace" },
        manager: true
      });
      await client.query("COMMIT");
      expect(result.found).toBe(true);
    } finally {
      client.release();
    }
    const row = (await pool.query<{ assigned_user_id: string | null }>(
      "SELECT assigned_user_id FROM conversations WHERE id=$1",
      [conversation]
    )).rows[0];
    expect(row.assigned_user_id).toBe(operatorId);
  });

  it("nova conversa do telefone mesclado é vinculada ao principal", async () => {
    const { target, sourcePhone } = await mergedPair();
    const linked = (await pool.query<{ lead_id: string }>(
      `INSERT INTO conversations(tenant_id,session_id,contact_phone,contact_name,status)
       VALUES($1,$2,$3,'Contato origem','open') RETURNING lead_id`,
      [tenantId, otherSessionId, sourcePhone]
    )).rows[0];
    expect(linked.lead_id).toBe(target);
  });

  it("findLeadByPhone e upsertLead não ressuscitam o source mesclado", async () => {
    const { source, target, sourcePhone } = await mergedPair();
    expect((await findLeadByPhone(tenantId, sourcePhone))?.id).toBe(target);
    const upserted = await upsertLead(tenantId, { telefone: sourcePhone, nome: "Mesmo contato" });
    expect(upserted.row.id).toBe(target);
    const sourceRow = (await pool.query<{ deleted_at: Date | null; merged_into_id: string | null }>(
      "SELECT deleted_at,merged_into_id FROM scheduling_leads WHERE id=$1",
      [source]
    )).rows[0];
    expect(sourceRow.deleted_at).not.toBeNull();
    expect(sourceRow.merged_into_id).toBe(target);
  });

  it("mensagem recebida do telefone mesclado carrega o lead principal no contexto da IA", async () => {
    const { target, sourcePhone } = await mergedPair();
    const context = await new MessageRepository(pool).recordInboundAndLoadContext({
      externalId: `merged-${randomUUID()}`, tenantId, sessionId, contactPhone: sourcePhone, text: "Oi de novo"
    });
    expect(context?.registeredLead?.id).toBe(target);
  });
});

describe("C12 — merge respeita o escopo do caso", () => {
  it("operador (escopo mine) não faz preflight de contato de outro responsável", async () => {
    const own = await createLead(nextPhone(), operatorMemberId);
    const ownToo = await createLead(nextPhone(), operatorMemberId);
    const foreign = await createLead(nextPhone(), ownerMemberId);
    const cookie = await loginAs(operatorId);
    const preflight = (source: string, target: string) => app.inject({
      method: "POST", url: "/organization/leads/merge/preflight", headers: { cookie },
      payload: { source_id: source, target_id: target }
    });
    expect((await preflight(own, ownToo)).statusCode).toBe(200);
    expect((await preflight(foreign, own)).statusCode).toBe(404);
    expect((await preflight(own, foreign)).statusCode).toBe(404);
  });
});
