import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { config } from "../src/config.js";
import { MessageRepository } from "../src/modules/messages/repository.js";
import { parseInternalRealtimeSignal, REALTIME_POSTGRES_CHANNEL } from "../src/modules/realtime/signals.js";

// MSG C5: o worker morre no meio do turno; o BullMQ devolve o MESMO job
// (mesmo aiTurnId) antes da lease de 10 min vencer. Esse retry precisa
// retomar a mensagem — antes virava "duplicate" e o contato ficava sem resposta.
const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const suffix = randomUUID();
const phone = `5511${suffix.replace(/\D/g, "").padEnd(9, "3").slice(0, 9)}`;
let tenantId = "";
let sessionId = "";

beforeAll(async () => {
  tenantId = (await pool.query<{ id: string }>("INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id", [`Claim turn ${suffix}`])).rows[0].id;
  sessionId = (await pool.query<{ id: string }>("INSERT INTO whatsapp_sessions(tenant_id,status) VALUES($1,'connected') RETURNING id", [tenantId])).rows[0].id;
  // Agente ativo: sem ele o repositório marca todo inbound como processado na hora.
  const configId = (await pool.query<{ id: string }>(
    `INSERT INTO agent_configs(tenant_id,name,system_prompt,ai_model,model_params,enabled_tools,is_active,updated_at)
     VALUES($1,'Agente','PROMPT','openai/gpt-4o-mini','{}'::jsonb,'[]'::jsonb,true,now()) RETURNING id`,
    [tenantId]
  )).rows[0].id;
  const versionId = (await pool.query<{ id: string }>(
    "SELECT id FROM agent_config_versions WHERE agent_config_id=$1 AND status='active'", [configId]
  )).rows[0].id;
  await pool.query("UPDATE agent_configs SET active_version_id=$2 WHERE id=$1", [configId, versionId]);
});

afterAll(async () => {
  if (tenantId) await pool.query("DELETE FROM tenants WHERE id=$1", [tenantId]);
  await pool.end();
});

describe("inbound claim lease by AI turn", () => {
  it("the retry of the same turn re-acquires a fresh lease; another turn does not", async () => {
    const repository = new MessageRepository(pool, config, { followUp: vi.fn().mockResolvedValue(undefined) });
    const message = { tenantId, sessionId, contactPhone: phone, text: "oi", externalId: `crash-${suffix}` };
    const turnId = `turn-${suffix}`;
    await repository.recordInboundAndLoadContext(message, { turnId });
    // Estado de um turno que morreu no meio: lease recente, mensagem não processada.
    await pool.query(
      "UPDATE messages SET processed_at=NULL,processing_started_at=now() WHERE external_message_id=$1",
      [message.externalId]
    );

    await expect(repository.recordInboundAndLoadContext(message, { turnId: `other-${suffix}` })).resolves.toBeNull();
    await expect(repository.recordInboundAndLoadContext(message, { turnId })).resolves.not.toBeNull();
  });
});

describe("pending contact fragments (MSG C7)", () => {
  it("a turn fired by the newest fragment also takes the older unanswered fragments, in order", async () => {
    const repository = new MessageRepository(pool, config, { followUp: vi.fn().mockResolvedValue(undefined) });
    const contact = `5511${randomUUID().replace(/\D/g, "").padEnd(9, "4").slice(0, 9)}`;
    const base = { tenantId, sessionId, contactPhone: contact };
    const ids = ["oi", "quero saber o preço", "do plano X"].map((text, index) => ({ text, externalId: `frag-${index}-${suffix}` }));
    let conversationId = "";
    for (const fragment of ids) {
      // Fora do expediente o webhook grava na hora (claim:false); cada job dispara depois.
      const context = await repository.recordInboundAndLoadContext({ ...base, ...fragment }, { claim: false });
      conversationId = context!.conversationId;
    }
    const pending = await repository.findPendingContactTextMessages(conversationId, ids[2].externalId);
    expect(pending.map((item) => item.text)).toEqual(["oi", "quero saber o preço", "do plano X"]);
  });
});

describe("realtime signal of in-place message changes (ORG C6)", () => {
  it("is accepted by the strict realtime schema, with a unique entityId per change", async () => {
    const repository = new MessageRepository(pool, config, { followUp: vi.fn().mockResolvedValue(undefined) });
    const context = await repository.recordInboundAndLoadContext(
      { tenantId, sessionId, contactPhone: `5511${randomUUID().replace(/\D/g, "").padEnd(9, "5").slice(0, 9)}`, text: "sinal", externalId: `signal-${suffix}` },
      { claim: false }
    );
    const listener = new pg.Client({ connectionString: config.DATABASE_URL });
    await listener.connect();
    const payloads: string[] = [];
    listener.on("notification", (notification) => { if (notification.payload) payloads.push(notification.payload); });
    await listener.query(`LISTEN ${REALTIME_POSTGRES_CHANNEL}`);
    try {
      // Eco/reação do Instagram atualizam a linha no lugar e sinalizam por aqui.
      const notify = (repository as unknown as { notifyConversationMessagesChanged(tenant: string, conversation: string): Promise<void> })
        .notifyConversationMessagesChanged.bind(repository);
      await notify(tenantId, context!.conversationId);
      await notify(tenantId, context!.conversationId);
      await vi.waitFor(() => expect(payloads.length).toBeGreaterThanOrEqual(2), { timeout: 2_000 });
      const signals = payloads.map((payload) => parseInternalRealtimeSignal(payload))
        .filter((signal) => signal?.type === "conversation.messages.changed" && signal.conversationId === context!.conversationId);
      expect(signals).toHaveLength(2);
      expect(signals[0]).toMatchObject({ tenantId });
      expect(signals[0]!.entityId).not.toBe(signals[1]!.entityId);
    } finally {
      await listener.end();
    }
  });
});
