import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ensureWorkspaceDefaultRoles } from "../src/auth/rbac.js";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";
import { MessageRepository } from "../src/modules/messages/repository.js";
import { QualificationService } from "../src/modules/qualification/service.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const app = buildApp();
const messages = new MessageRepository(pool);
const qualification = new QualificationService();
const apiKey = `assignment-entrypoints-${randomUUID()}`;
const apiHeaders = { "x-api-key": apiKey };

let tenantId = "";
let sessionId = "";
let betoUserId = "";
let betoMemberId = "";
let juliaUserId = "";
let juliaMemberId = "";
let phoneSequence = 0;

const nextPhone = () => `551197${String(++phoneSequence).padStart(6, "0")}`;

async function createConversation(phone: string): Promise<string> {
  return (await pool.query<{ id: string }>(
    `INSERT INTO conversations(tenant_id,session_id,contact_phone,contact_name)
     VALUES($1,$2,$3,'Contato de entrada') RETURNING id`,
    [tenantId, sessionId, phone]
  )).rows[0].id;
}

async function assignmentState(phone: string) {
  const [lead, conversation, cursor] = await Promise.all([
    pool.query<{ id: string; assigned_member_id: string | null }>(
      `SELECT id,assigned_member_id FROM scheduling_leads
       WHERE tenant_id=$1
         AND regexp_replace(phone,'\\D','','g')=regexp_replace($2,'\\D','','g')
       ORDER BY created_at,id`,
      [tenantId, phone]
    ),
    pool.query<{ id: string; status: string; assigned_user_id: string | null }>(
      `SELECT id,status,assigned_user_id FROM conversations
       WHERE tenant_id=$1
         AND regexp_replace(contact_phone,'\\D','','g')=regexp_replace($2,'\\D','','g')
       ORDER BY created_at,id`,
      [tenantId, phone]
    ),
    pool.query<{ last_member_id: string | null }>(
      "SELECT last_member_id FROM attendant_assignment_cursors WHERE tenant_id=$1",
      [tenantId]
    )
  ]);
  return {
    leads: lead.rows,
    conversations: conversation.rows,
    cursor: cursor.rows[0]?.last_member_id ?? null
  };
}

async function recordInbound(
  phone: string,
  externalId: string,
  text = "Olá, quero saber mais"
) {
  return messages.recordInboundAndLoadContext({
    tenantId,
    sessionId,
    contactPhone: phone,
    contactName: "Contato de entrada",
    externalId,
    text
  });
}

beforeAll(async () => {
  await app.ready();
  tenantId = (await pool.query<{ id: string }>(
    "INSERT INTO tenants(name,status,timezone) VALUES($1,'active','UTC') RETURNING id",
    [`Assignment entrypoints ${randomUUID()}`]
  )).rows[0].id;
  sessionId = (await pool.query<{ id: string }>(
    "INSERT INTO whatsapp_sessions(tenant_id,status) VALUES($1,'connected') RETURNING id",
    [tenantId]
  )).rows[0].id;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await ensureWorkspaceDefaultRoles(client, tenantId);
    betoUserId = (await client.query<{ id: string }>(
      "INSERT INTO users(email,status) VALUES($1,'active') RETURNING id",
      [`beto-entrypoints-${randomUUID()}@test.local`]
    )).rows[0].id;
    juliaUserId = (await client.query<{ id: string }>(
      "INSERT INTO users(email,status) VALUES($1,'active') RETURNING id",
      [`julia-entrypoints-${randomUUID()}@test.local`]
    )).rows[0].id;
    betoMemberId = (await client.query<{ id: string }>(
      `INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at)
       SELECT $1,$2,id,'active',now()
       FROM workspace_roles WHERE workspace_id=$1 AND name='OPERADOR'
       RETURNING id`,
      [tenantId, betoUserId]
    )).rows[0].id;
    juliaMemberId = (await client.query<{ id: string }>(
      `INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at)
       SELECT $1,$2,id,'active',now()
       FROM workspace_roles WHERE workspace_id=$1 AND name='OPERADOR'
       RETURNING id`,
      [tenantId, juliaUserId]
    )).rows[0].id;
    await client.query(
      `INSERT INTO scheduling_google_meet_closers(
         tenant_id,member_id,created_at,availability_status
       ) VALUES
         ($1,$2,'2026-01-01T00:00:00Z','available'),
         ($1,$3,'2026-01-02T00:00:00Z','unavailable')`,
      [tenantId, betoMemberId, juliaMemberId]
    );
    await client.query(
      "INSERT INTO scheduling_categories(tenant_id,id,name) VALUES($1,'entrypoint-category','Entrypoint category')",
      [tenantId]
    );
    await client.query(
      `INSERT INTO scheduling_units(
         tenant_id,id,name,opening_time,closing_time,operating_days,slot_duration_min,simultaneous_capacity
       ) VALUES(
         $1,'entrypoint-unit','Entrypoint unit','00:00','23:59',
         ARRAY[0,1,2,3,4,5,6]::smallint[],30,100
       )`,
      [tenantId]
    );
    await client.query(
      `INSERT INTO qualification_flows(tenant_id,id,name,active,definition)
       VALUES($1,'entrypoint-flow','Entrypoint flow',true,$2)`,
      [
        tenantId,
        {
          start: "question",
          origem: "facebook",
          triggers: { ctwa: false, session_ids: [sessionId], keywords: [] },
          steps: {
            question: {
              kind: "text",
              field: "interest",
              question: "Qual é o seu interesse?",
              next: "finished"
            },
            finished: {
              kind: "final",
              message: "Obrigado pelas informações."
            }
          }
        }
      ]
    );
    await client.query(
      "INSERT INTO tenant_api_keys(tenant_id,name,key_hash) VALUES($1,'Assignment entrypoints',$2)",
      [tenantId, createHash("sha256").update(apiKey).digest("hex")]
    );
    await client.query(
      "INSERT INTO agent_configs(tenant_id,system_prompt,ai_model) VALUES($1,'Prompt de entrada','test/assignment')",
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

beforeEach(async () => {
  await pool.query("DELETE FROM audit_logs WHERE workspace_id=$1", [tenantId]);
  await pool.query("DELETE FROM qualification_message_outbox WHERE tenant_id=$1", [tenantId]);
  await pool.query("DELETE FROM lead_qualifications WHERE tenant_id=$1", [tenantId]);
  await pool.query("DELETE FROM conversations WHERE tenant_id=$1", [tenantId]);
  await pool.query("DELETE FROM scheduling_appointments WHERE tenant_id=$1", [tenantId]);
  await pool.query("DELETE FROM scheduling_leads WHERE tenant_id=$1", [tenantId]);
  await pool.query(
    `INSERT INTO attendant_assignment_cursors(tenant_id,last_member_id)
     VALUES($1,NULL)
     ON CONFLICT(tenant_id) DO UPDATE SET last_member_id=NULL,updated_at=now()`,
    [tenantId]
  );
});

afterAll(async () => {
  await pool.query(
    "DELETE FROM audit_logs WHERE workspace_id=$1 OR actor_user_id=ANY($2::uuid[])",
    [tenantId, [betoUserId, juliaUserId]]
  );
  await pool.query("DELETE FROM tenants WHERE id=$1", [tenantId]);
  await pool.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [[betoUserId, juliaUserId]]);
  await app.close();
  await pool.end();
});

describe("assignment through inbound messages", () => {
  it("assigns the first message once and preserves the cursor on idempotent and open-conversation repeats", async () => {
    const firstPhone = nextPhone();
    const externalId = `inbound-first-${randomUUID()}`;

    expect(await recordInbound(firstPhone, externalId)).not.toBeNull();
    expect(await assignmentState(firstPhone)).toMatchObject({
      leads: [{ assigned_member_id: betoMemberId }],
      conversations: [{ status: "open", assigned_user_id: betoUserId }],
      cursor: betoMemberId
    });

    expect(await recordInbound(firstPhone, externalId)).toBeNull();
    expect(await recordInbound(firstPhone, `inbound-open-${randomUUID()}`, "Outra mensagem")).not.toBeNull();
    expect((await assignmentState(firstPhone)).cursor).toBe(betoMemberId);
    expect((await pool.query<{ total: number }>(
      `SELECT count(*)::int total FROM messages message
       JOIN conversations conversation ON conversation.id=message.conversation_id
       WHERE conversation.tenant_id=$1
         AND regexp_replace(conversation.contact_phone,'\\D','','g')=$2`,
      [tenantId, firstPhone]
    )).rows[0].total).toBe(2);

    const secondPhone = nextPhone();
    expect(await recordInbound(secondPhone, `inbound-second-${randomUUID()}`)).not.toBeNull();
    expect(await assignmentState(secondPhone)).toMatchObject({
      leads: [{ assigned_member_id: juliaMemberId }],
      conversations: [{ assigned_user_id: juliaUserId }],
      cursor: juliaMemberId
    });
  });

  it("rotates exactly once when a closed conversation receives a new inbound message", async () => {
    const phone = nextPhone();
    const firstExternalId = `inbound-before-close-${randomUUID()}`;
    await recordInbound(phone, firstExternalId);
    const initial = await assignmentState(phone);
    await pool.query(
      "UPDATE conversations SET status='closed',resolved_at=now() WHERE tenant_id=$1 AND id=$2",
      [tenantId, initial.conversations[0].id]
    );

    const returnExternalId = `inbound-return-${randomUUID()}`;
    expect(await recordInbound(phone, returnExternalId)).not.toBeNull();
    expect(await assignmentState(phone)).toMatchObject({
      leads: [{ assigned_member_id: juliaMemberId }],
      conversations: [{ status: "open", assigned_user_id: juliaUserId }],
      cursor: juliaMemberId
    });
    expect(await recordInbound(phone, returnExternalId)).toBeNull();
    expect((await assignmentState(phone)).cursor).toBe(juliaMemberId);

    const nextContact = nextPhone();
    await recordInbound(nextContact, `inbound-after-return-${randomUUID()}`);
    expect(await assignmentState(nextContact)).toMatchObject({
      leads: [{ assigned_member_id: betoMemberId }],
      conversations: [{ assigned_user_id: betoUserId }],
      cursor: betoMemberId
    });
  });

  it("keeps the current open assignee and rejects a second canonical conversation", async () => {
    const phone = nextPhone();
    const currentOpenId = (await pool.query<{ id: string }>(
      `INSERT INTO conversations(
         tenant_id,session_id,contact_phone,contact_name,status,assigned_user_id,claimed_at
       ) VALUES($1,$2,$3,'Atendimento Beto','open',$4,now())
       RETURNING id`,
      [tenantId, sessionId, phone, betoUserId]
    )).rows[0].id;
    await expect(pool.query(
      `INSERT INTO conversations(
         tenant_id,session_id,contact_phone,contact_name,status,assigned_user_id,
         claimed_at,resolved_at,created_at
       ) VALUES($1,$2,$3,'Histórico Julia','closed',$4,
         now()-interval '2 days',now()-interval '1 day',now()-interval '2 days')`,
      [tenantId, sessionId, phone, juliaUserId]
    )).rejects.toThrow(/unique constraint/);
    await pool.query(
      `INSERT INTO attendant_assignment_cursors(tenant_id,last_member_id)
       VALUES($1,$2)
       ON CONFLICT(tenant_id) DO UPDATE SET last_member_id=$2,updated_at=now()`,
      [tenantId, betoMemberId]
    );

    const externalId = `inbound-open-wins-${randomUUID()}`;
    expect(await recordInbound(phone, externalId)).not.toBeNull();
    expect(await assignmentState(phone)).toMatchObject({
      leads: [{ assigned_member_id: betoMemberId }],
      conversations: [{ id: currentOpenId, status: "open", assigned_user_id: betoUserId }],
      cursor: betoMemberId
    });
    expect((await pool.query<{ conversation_id: string }>(
      "SELECT conversation_id FROM messages WHERE external_message_id=$1",
      [externalId]
    )).rows[0].conversation_id).toBe(currentOpenId);
  });
});

describe("assignment through AI qualification", () => {
  it("assigns startFlow once and leaves repeated qualification input on the same turn", async () => {
    const firstPhone = nextPhone();
    await createConversation(firstPhone);
    const externalId = `qualification-first-${randomUUID()}`;
    const input = {
      tenantId,
      sessionId,
      contactPhone: firstPhone,
      contactName: "Lead IA",
      text: "Quero iniciar",
      externalId
    };

    expect(await qualification.handleInbound(input)).toMatchObject({
      reply: expect.stringContaining("Qual é o seu interesse?")
    });
    expect(await assignmentState(firstPhone)).toMatchObject({
      leads: [{ assigned_member_id: betoMemberId }],
      conversations: [{ assigned_user_id: betoUserId }],
      cursor: betoMemberId
    });
    expect(await qualification.handleInbound(input)).toMatchObject({
      reply: expect.stringContaining("Qual é o seu interesse?")
    });
    expect((await assignmentState(firstPhone)).cursor).toBe(betoMemberId);

    const secondPhone = nextPhone();
    await createConversation(secondPhone);
    expect(await qualification.handleInbound({
      ...input,
      contactPhone: secondPhone,
      externalId: `qualification-second-${randomUUID()}`
    })).not.toBeNull();
    expect(await assignmentState(secondPhone)).toMatchObject({
      leads: [{ assigned_member_id: juliaMemberId }],
      conversations: [{ assigned_user_id: juliaUserId }],
      cursor: juliaMemberId
    });
  });
});

describe("assignment through the tenant API", () => {
  it("persists an assigned POST /leads result and does not advance on normalized-phone upsert", async () => {
    const firstPhone = nextPhone();
    const firstConversationId = await createConversation(firstPhone);
    const linkedLeadId = (await pool.query<{ lead_id: string }>(
      "SELECT lead_id FROM conversations WHERE tenant_id=$1 AND id=$2",
      [tenantId, firstConversationId]
    )).rows[0].lead_id;
    const first = await app.inject({
      method: "POST",
      url: "/leads",
      headers: apiHeaders,
      payload: {
        telefone: firstPhone,
        nome: "Lead API",
        categoria_interesse_id: "entrypoint-category",
        unidade_id: "entrypoint-unit",
        origem: "api-test"
      }
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().lead.id).toBe(linkedLeadId);
    expect(await assignmentState(firstPhone)).toMatchObject({
      leads: [{ assigned_member_id: betoMemberId }],
      conversations: [{ assigned_user_id: betoUserId }],
      cursor: betoMemberId
    });

    const repeated = await app.inject({
      method: "POST",
      url: "/leads",
      headers: apiHeaders,
      payload: {
        telefone: `+55 (11) 97${firstPhone.slice(-6, -4)}-${firstPhone.slice(-4)}`,
        nome: "Lead API atualizado"
      }
    });
    expect(repeated.statusCode).toBe(200);
    expect(repeated.json().lead).toMatchObject({
      id: first.json().lead.id
    });
    expect((await assignmentState(firstPhone)).cursor).toBe(betoMemberId);

    const secondPhone = nextPhone();
    const second = await app.inject({
      method: "POST",
      url: "/leads",
      headers: apiHeaders,
      payload: {
        telefone: secondPhone,
        nome: "Segundo lead API",
        categoria_interesse_id: "entrypoint-category",
        unidade_id: "entrypoint-unit",
        origem: "api-test"
      }
    });
    expect(second.statusCode).toBe(201);
    expect(await assignmentState(secondPhone)).toMatchObject({
      leads: [{ assigned_member_id: juliaMemberId }],
      conversations: [],
      cursor: juliaMemberId
    });
  });
});
