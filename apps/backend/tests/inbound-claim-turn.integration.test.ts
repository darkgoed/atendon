import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { config } from "../src/config.js";
import { MessageRepository } from "../src/modules/messages/repository.js";

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
