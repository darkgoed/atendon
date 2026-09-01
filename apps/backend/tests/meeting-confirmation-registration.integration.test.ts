import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { MeetingConfirmationRepository } from "../src/modules/scheduling/meeting-confirmation.js";

/**
 * Cobre a promoção AGENDADO -> CONFIRMADO contra o banco real.
 *
 * Existe porque `registerContactConfirmation` passou a ser chamada pelo
 * processamento de mensagens: um "sim" do contato precisa promover o
 * agendamento, e um "ok" solto fora do fluxo de confirmação não pode.
 */
const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const repository = new MeetingConfirmationRepository(pool);
const suffix = randomUUID();
let tenantId = "";
let unitId = "";

/**
 * Cria um lead novo por agendamento: o índice
 * `idx_appointments_one_active_per_lead` permite apenas um agendamento ativo
 * por lead, então reaproveitar o mesmo lead quebraria os casos.
 */
async function createAppointment(state: "nao_solicitada" | "solicitada"): Promise<string> {
  const lead = await pool.query<{ id: string }>(
    "INSERT INTO scheduling_leads(tenant_id, phone, name, source) VALUES($1,$2,$3,'whatsapp') RETURNING id",
    [tenantId, `5511${randomUUID().replace(/\D/g, "").slice(0, 9)}`, "Ana Souza"]
  );
  const start = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO scheduling_appointments(
       lead_id, tenant_id, unit_id, start_at, end_at, status,
       meeting_provisioning_status, contact_confirmation_state
     ) VALUES($1,$2,$3,$4,$5,'confirmado','not_required',$6) RETURNING id`,
    [lead.rows[0]!.id, tenantId, unitId, start, new Date(start.getTime() + 40 * 60 * 1000), state]
  );
  return inserted.rows[0]!.id;
}

async function stateOf(appointmentId: string): Promise<string> {
  const row = await pool.query<{ contact_confirmation_state: string }>(
    "SELECT contact_confirmation_state FROM scheduling_appointments WHERE id=$1",
    [appointmentId]
  );
  return row.rows[0]!.contact_confirmation_state;
}

beforeAll(async () => {
  const tenant = await pool.query<{ id: string }>(
    "INSERT INTO tenants(name, slug) VALUES($1,$2) RETURNING id",
    [`confirm-${suffix}`, `confirm-${suffix}`]
  );
  tenantId = tenant.rows[0]!.id;
  const unit = await pool.query<{ id: string }>(
    `INSERT INTO scheduling_units(id, tenant_id, name, opening_time, closing_time, operating_days)
     VALUES($1,$2,'Unidade','08:00','18:00','{1,2,3,4,5}') RETURNING id`,
    [randomUUID(), tenantId]
  );
  unitId = unit.rows[0]!.id;
});

afterAll(async () => {
  if (tenantId) await pool.query("DELETE FROM tenants WHERE id=$1", [tenantId]);
  await pool.end();
});

describe("registerContactConfirmation", () => {
  it("promove a confirmada quando a confirmação foi solicitada", async () => {
    const appointmentId = await createAppointment("solicitada");
    await expect(repository.registerContactConfirmation(tenantId, appointmentId, "sim, pode contar comigo")).resolves.toBe(true);
    expect(await stateOf(appointmentId)).toBe("confirmada");
  });

  it("ignora afirmação quando a confirmação ainda não foi solicitada", async () => {
    // Sem essa trava, um "ok" dito em qualquer ponto da conversa marcaria o
    // lead como confirmado e silenciaria os lembretes de quem nunca confirmou.
    const appointmentId = await createAppointment("nao_solicitada");
    await expect(repository.registerContactConfirmation(tenantId, appointmentId, "ok")).resolves.toBe(false);
    expect(await stateOf(appointmentId)).toBe("nao_solicitada");
  });

  it("não confirma diante de recusa ou hesitação", async () => {
    const recusa = await createAppointment("solicitada");
    await expect(repository.registerContactConfirmation(tenantId, recusa, "não vou conseguir")).resolves.toBe(false);
    expect(await stateOf(recusa)).toBe("solicitada");

    const hesitacao = await createAppointment("solicitada");
    await expect(repository.registerContactConfirmation(tenantId, hesitacao, "acho que consigo")).resolves.toBe(false);
    expect(await stateOf(hesitacao)).toBe("solicitada");
  });

  it("é idempotente e isolada por tenant", async () => {
    const appointmentId = await createAppointment("solicitada");
    await expect(repository.registerContactConfirmation(tenantId, appointmentId, "sim")).resolves.toBe(true);
    // Segunda chamada não deve reportar nova confirmação.
    await expect(repository.registerContactConfirmation(tenantId, appointmentId, "sim")).resolves.toBe(false);

    const outroTenant = await createAppointment("solicitada");
    await expect(repository.registerContactConfirmation(randomUUID(), outroTenant, "sim")).resolves.toBe(false);
    expect(await stateOf(outroTenant)).toBe("solicitada");
  });
});

describe("markSent", () => {
  /**
   * O lembrete precisa aparecer na conversa do painel. Sem isso ele chega no
   * WhatsApp do contato e some para o time comercial, que responde ao lead sem
   * ver o que a operação acabou de mandar — foi exatamente o que aconteceu no
   * primeiro disparo real.
   */
  async function createConversation(): Promise<{ conversationId: string; sessionId: string; leadId: string }> {
    const sessionId = randomUUID();
    const lead = await pool.query<{ id: string }>(
      "INSERT INTO scheduling_leads(tenant_id, phone, name, source) VALUES($1,$2,$3,'whatsapp') RETURNING id",
      [tenantId, `5511${randomUUID().replace(/\D/g, "").slice(0, 9)}`, "Rodrigo Melfi"]
    );
    await pool.query(
      "INSERT INTO whatsapp_sessions(id, tenant_id, status) VALUES($1,$2,'connected')",
      [sessionId, tenantId]
    );
    const conversation = await pool.query<{ id: string }>(
      `INSERT INTO conversations(tenant_id, session_id, contact_phone, lead_id, last_message_at)
       VALUES($1,$2,$3,$4, now() - interval '2 hours') RETURNING id`,
      [tenantId, sessionId, `5511${randomUUID().replace(/\D/g, "").slice(0, 9)}`, lead.rows[0]!.id]
    );
    return { conversationId: conversation.rows[0]!.id, sessionId, leadId: lead.rows[0]!.id };
  }

  function claimedFor(conversationId: string, sessionId: string, appointmentId: string) {
    return {
      id: randomUUID(),
      tenantId,
      appointmentId,
      conversationId,
      sessionId,
      destination: "5511999999999",
      messageText: "Rodrigo, estamos a 15 minutos do nosso horário\n\nConsegue me confirmar se vai conseguir entrar?",
      moment: "quinze_minutos_antes" as const,
      state: "solicitada" as const
    };
  }

  it("grava a mensagem enviada na conversa e reordena a lista", async () => {
    const { conversationId, sessionId } = await createConversation();
    const appointmentId = await createAppointment("solicitada");
    const externalId = `EXT-${randomUUID()}`;
    const before = await pool.query<{ last_message_at: Date }>(
      "SELECT last_message_at FROM conversations WHERE id=$1", [conversationId]
    );

    await repository.markSent(claimedFor(conversationId, sessionId, appointmentId), externalId);

    const message = await pool.query<{ sender: string; content: string; status: string }>(
      "SELECT sender, content, status FROM messages WHERE external_message_id=$1", [externalId]
    );
    expect(message.rows).toHaveLength(1);
    expect(message.rows[0]!.sender).toBe("agent");
    expect(message.rows[0]!.status).toBe("sent");
    expect(message.rows[0]!.content).toContain("15 minutos");

    const after = await pool.query<{ last_message_at: Date }>(
      "SELECT last_message_at FROM conversations WHERE id=$1", [conversationId]
    );
    expect(after.rows[0]!.last_message_at.getTime()).toBeGreaterThan(before.rows[0]!.last_message_at.getTime());
  });

  it("não duplica a mensagem se o envio for reprocessado", async () => {
    const { conversationId, sessionId } = await createConversation();
    const appointmentId = await createAppointment("solicitada");
    const externalId = `EXT-${randomUUID()}`;
    const delivery = claimedFor(conversationId, sessionId, appointmentId);

    await repository.markSent(delivery, externalId);
    await repository.markSent(delivery, externalId);

    const count = await pool.query<{ count: string }>(
      "SELECT count(*) FROM messages WHERE external_message_id=$1", [externalId]
    );
    expect(count.rows[0]!.count).toBe("1");
  });

  it("não grava em conversa de outro tenant", async () => {
    const { conversationId, sessionId } = await createConversation();
    const appointmentId = await createAppointment("solicitada");
    const externalId = `EXT-${randomUUID()}`;
    const delivery = { ...claimedFor(conversationId, sessionId, appointmentId), tenantId: randomUUID() };

    await repository.markSent(delivery, externalId);

    const count = await pool.query<{ count: string }>(
      "SELECT count(*) FROM messages WHERE external_message_id=$1", [externalId]
    );
    expect(count.rows[0]!.count).toBe("0");
  });
});
