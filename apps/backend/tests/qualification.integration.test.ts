import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureWorkspaceDefaultRoles } from "../src/auth/rbac.js";
import { config } from "../src/config.js";
import {
  createQualifiedMeetingAppointment,
  qualifyLead,
  upsertLead
} from "../src/modules/scheduling/service.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
let tenantId = "";
let closerUserId = "";

beforeAll(async () => {
  tenantId = (await pool.query<{ id: string }>(
    "INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id",
    [`Agentic qualification ${randomUUID()}`]
  )).rows[0].id;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await ensureWorkspaceDefaultRoles(client, tenantId);
    closerUserId = (await client.query<{ id: string }>(
      "INSERT INTO users(email,status) VALUES($1,'active') RETURNING id",
      [`qualification-closer-${randomUUID()}@test.local`]
    )).rows[0].id;
    const closerMemberId = (await client.query<{ id: string }>(
      `INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at)
       SELECT $1,$2,id,'active',now()
       FROM workspace_roles WHERE workspace_id=$1 AND name='OPERADOR'
       RETURNING id`,
      [tenantId, closerUserId]
    )).rows[0].id;
    await client.query(
      "INSERT INTO scheduling_google_meet_closers(tenant_id,member_id) VALUES($1,$2)",
      [tenantId, closerMemberId]
    );
    await client.query(
      `INSERT INTO scheduling_units(tenant_id,id,name,opening_time,closing_time,operating_days,slot_duration_min,simultaneous_capacity)
       VALUES($1,'reunioes','Reuniões','09:00','18:00',ARRAY[1,2,3,4,5]::smallint[],60,1)`,
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
  if (tenantId) await pool.query("DELETE FROM tenants WHERE id=$1", [tenantId]);
  if (closerUserId) await pool.query("DELETE FROM users WHERE id=$1", [closerUserId]);
  await pool.end();
});

async function createLead(phone: string) {
  return (await upsertLead(tenantId, { telefone: phone, origem: "facebook", nome: "Contato Newave" }, {
    facebookAttribution: { provider: "meta", channel: "facebook", source_type: "ad", source_id: "ad-safe" }
  })).row;
}

describe("agentic Newave qualification", () => {
  it("persists a 2-star evaluation idempotently and keeps it eligible for scheduling", async () => {
    const lead = await createLead(`5511${Date.now().toString().slice(-8)}`);
    const input = {
      estrelas: 2,
      respostas: { tempo_mercado: "resposta indireta: começou durante a pandemia", nicho: "ótica" },
      resumo: "Negócio existente, mas o contato não informou faturamento e demonstrou baixa prontidão.",
      justificativa: "Há informação insuficiente e dúvidas relevantes; requer avaliação humana."
    } as const;
    const first = await qualifyLead(tenantId, lead.id, input);
    const second = await qualifyLead(tenantId, lead.id, input);
    expect(first).toMatchObject({ alterado: true, requer_decisao_humana: false });
    expect(second).toMatchObject({ alterado: false, requer_decisao_humana: false });

    const persisted = await pool.query(
      `SELECT qualification_stars,qualification_answers,qualification_summary,qualification_reason,
              qualification_evaluated_at,requires_human_decision,status,facebook_attribution
       FROM scheduling_leads WHERE id=$1`,
      [lead.id]
    );
    expect(persisted.rows[0]).toMatchObject({
      qualification_stars: 2,
      qualification_answers: input.respostas,
      requires_human_decision: false,
      status: "qualificado",
      facebook_attribution: expect.objectContaining({ source_id: "ad-safe" })
    });
    expect(persisted.rows[0].qualification_evaluated_at).toBeTruthy();
    expect((await pool.query(
      "SELECT count(*)::int count FROM scheduling_lead_events WHERE lead_id=$1 AND event_type='qualificacao_avaliada'",
      [lead.id]
    )).rows[0].count).toBe(1);
    await expect(createQualifiedMeetingAppointment(tenantId, {
      lead_id: lead.id, unidade_id: "reunioes", start: "2030-01-07T09:00:00.000Z"
    })).resolves.toMatchObject({ status: "confirmado" });
  });

  it("accepts and persists ticket_medio, cidade and decisor_comercial", async () => {
    const lead = await createLead(`5541${Date.now().toString().slice(-8)}`);
    const input = {
      estrelas: 4,
      respostas: {
        nicho: "motos",
        ticket_medio: "R$ 7.900 a R$ 9.900",
        cidade: "Porto Alegre",
        decisor_comercial: "sim, sou eu"
      },
      resumo: "Loja de motos com ticket médio definido e decisor no contato.",
      justificativa: "Perfil claro e pronto para avançar para reunião."
    } as const;
    await expect(qualifyLead(tenantId, lead.id, input)).resolves.toMatchObject({ alterado: true });

    const persisted = await pool.query(
      "SELECT qualification_answers FROM scheduling_leads WHERE id=$1",
      [lead.id]
    );
    expect(persisted.rows[0].qualification_answers).toEqual(input.respostas);
  });

  it("allows a 3-star opportunity to complete a meeting", async () => {
    const lead = await createLead(`5521${Date.now().toString().slice(-8)}`);
    await qualifyLead(tenantId, lead.id, {
      estrelas: 3,
      respostas: {
        tempo_mercado: "2 anos",
        faturamento: "aproximadamente R$ 35 mil",
        nicho: "eletrônicos",
        causa_perda_vendas: "poucas formas de pagamento",
        instagram: "@loja_teste"
      },
      resumo: "Operação viável com dor comercial clara e interesse em avançar.",
      justificativa: "Há aderência e contexto suficiente para uma conversa comercial."
    });
    const appointment = await createQualifiedMeetingAppointment(tenantId, {
      lead_id: lead.id, unidade_id: "reunioes", start: "2030-01-07T10:00:00.000Z"
    });
    expect(appointment).toMatchObject({ lead_id: lead.id, status: "confirmado" });
    expect((await pool.query("SELECT requires_human_decision,status FROM scheduling_leads WHERE id=$1", [lead.id])).rows[0])
      .toEqual({ requires_human_decision: false, status: "agendado" });
  });

  it("keeps tenants isolated", async () => {
    const foreign = await pool.query<{ id: string }>("INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id", [`Foreign ${randomUUID()}`]);
    const lead = await createLead(`5531${Date.now().toString().slice(-8)}`);
    try {
      await expect(qualifyLead(foreign.rows[0].id, lead.id, {
        estrelas: 5, respostas: {}, resumo: "Tentativa externa", justificativa: "Não deve persistir"
      })).rejects.toMatchObject({ statusCode: 404 });
    } finally {
      await pool.query("DELETE FROM tenants WHERE id=$1", [foreign.rows[0].id]);
    }
  });
});
