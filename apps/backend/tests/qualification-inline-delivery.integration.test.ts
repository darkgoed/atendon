// Corrida da PRIMEIRA mensagem do walk de inbound (fila inline em
// process-message) contra o pump da outbox: deliverOutboxById reivindica a MESMA
// linha (guard claimed_at/status) do pump, então cada mensagem sai EXATAMENTE
// uma vez mesmo com pumpOutbox rodando em paralelo — e o perdedor da corrida
// ("" / null) não reenvia nem grava em duplicidade.
// Sem Redis/HTTP: gateway é mock (com cancela no 1º sendText); banco real (atendon_test).
import { randomUUID } from "node:crypto";
import pg from "pg";
import { z } from "zod";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { config } from "../src/config.js";
import { flowDefinitionSchema } from "../src/modules/qualification/flow.js";
import type { MessageGateway } from "../src/modules/messages/types.js";
import { QualificationService } from "../src/modules/qualification/service.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const service = new QualificationService();

let tenantA = "";
let sessionIdA = "";

let phoneSequence = Number(Date.now().toString().slice(-7));
const nextPhone = () => `5511${String(++phoneSequence).padStart(8, "0").slice(-8)}`;

// message→final: a 1ª mensagem volta inline (reply+outboxId), a 2ª só sai pelo pump.
const twoMessagesFlow = {
  start: "M1",
  origem: "facebook",
  triggers: { ctwa: false, session_ids: [], keywords: ["robo"] },
  steps: {
    M1: { kind: "message", message: "Primeira mensagem!", next: "F1" },
    F1: { kind: "final", message: "Segunda mensagem (final)!", classificacao: "ok" }
  }
} satisfies z.input<typeof flowDefinitionSchema>;

function mockGateway(): { gateway: MessageGateway; texts: string[]; releaseFirst: () => void } {
  const idPrefix = `ext-${randomUUID()}`;
  let counter = 0;
  const texts: string[] = [];
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const gateway = {
    sendText: vi.fn(async (_sessionId: string, _destination: string, text: string) => {
      const sequence = ++counter; // captura antes do await: counter muda enquanto o 1º espera a cancela
      if (sequence === 1) await firstGate; // segura o vencedor da corrida até os dois competidores estarem a caminho
      texts.push(text);
      return { externalId: `${idPrefix}-${sequence}` };
    }),
    sendPresence: vi.fn(async () => {}),
    markMessageAsRead: vi.fn(async () => {}),
    setPresence: vi.fn(async () => {})
  } as unknown as MessageGateway;
  return { gateway, texts, releaseFirst };
}

async function outboxRows(qualificationId: string) {
  const result = await pool.query<{ id: string; step_id: string; message_kind: string; status: string; external_message_id: string | null; message: string }>(
    `SELECT id,step_id,message_kind,status,external_message_id,message
     FROM qualification_message_outbox WHERE qualification_id=$1 ORDER BY created_at,id`,
    [qualificationId]
  );
  return result.rows;
}

async function qualificationIdFor(tenantId: string, phone: string): Promise<string> {
  const row = await pool.query<{ id: string }>(
    `SELECT q.id FROM lead_qualifications q
     JOIN scheduling_leads l ON l.id=q.lead_id AND l.tenant_id=q.tenant_id
     WHERE q.tenant_id=$1 AND l.phone=$2`,
    [tenantId, phone]
  );
  expect(row.rows[0]).toBeDefined();
  return row.rows[0].id;
}

beforeAll(async () => {
  tenantA = (await pool.query<{ id: string }>(
    "INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id",
    [`Fluxos inline delivery ${randomUUID()}`]
  )).rows[0].id;
  sessionIdA = (await pool.query<{ id: string }>(
    "INSERT INTO whatsapp_sessions(tenant_id,channel,status) VALUES($1,'whatsapp','connected') RETURNING id",
    [tenantA]
  )).rows[0].id;
  await pool.query(
    "INSERT INTO qualification_flows(tenant_id,id,name,active,definition) VALUES($1,$2,$3,false,$4)",
    [tenantA, "inline-two-msgs", "inline-two-msgs", twoMessagesFlow]
  );
  await pool.query("UPDATE qualification_flows SET active=true WHERE tenant_id=$1 AND id=$2", [tenantA, "inline-two-msgs"]);
});

afterAll(async () => {
  await pool.query("DELETE FROM tenants WHERE id=$1", [tenantA]);
  await pool.end();
});

describe("Entrega inline da 1ª mensagem do robô vs pump da outbox", () => {
  it("deliverOutboxById concorrente ao pump entrega cada mensagem exatamente uma vez (sem duplicar envio)", async () => {
    const phone = nextPhone();
    await pool.query("INSERT INTO conversations(tenant_id,session_id,contact_phone) VALUES($1,$2,$3)", [tenantA, sessionIdA, phone]);
    const outcome = await service.handleInbound({
      tenantId: tenantA, sessionId: sessionIdA, contactPhone: phone, text: "robo", externalId: `start-${randomUUID()}`
    });
    expect(outcome?.reply).toBe("Primeira mensagem!");
    expect(outcome?.outboxId).toBeDefined();
    const qualificationId = await qualificationIdFor(tenantA, phone);
    expect((await outboxRows(qualificationId)).every((row) => row.status === "pending")).toBe(true);

    const { gateway, texts, releaseFirst } = mockGateway();
    // Corrida real: pump e entrega inline partem juntos; a cancela segura o 1º
    // sendText até os dois estarem no ar (janela de reivindicação simultânea).
    const pumpPromise = service.pumpOutbox(gateway);
    const inlinePromise = new QualificationService().deliverOutboxById(outcome!.outboxId!, gateway);
    await new Promise((resolve) => setTimeout(resolve, 25));
    releaseFirst();
    const [pumped, inlineId] = await Promise.all([pumpPromise, inlinePromise]);

    // Cada texto sai exatamente uma vez — a antiga implementação (sendText +
    // markSent incondicional) duplicava "Primeira mensagem!" com o pump vivo.
    expect(texts).toContain("Primeira mensagem!");
    expect(texts).toContain("Segunda mensagem (final)!");
    expect(new Set(texts).size).toBe(texts.length);
    // Pump pode vencer as duas corridas; inline entrega só quando vence a 1ª.
    expect(pumped + (inlineId ? 1 : 0)).toBe(2);
    // A outbox fica toda sent, e a tabela messages tem 1 linha agent por texto
    // (chave única do provedor, persistida por deliverOutbox).
    const rows = await outboxRows(qualificationId);
    expect(rows.every((row) => row.status === "sent")).toBe(true);
    const messages = (await pool.query<{ content: string; external_message_id: string | null }>(
      `SELECT m.content,m.external_message_id FROM messages m
       JOIN conversations c ON c.id=m.conversation_id
       WHERE c.tenant_id=$1 AND c.session_id=$2 AND c.contact_phone=$3 AND m.sender='agent'
       ORDER BY m.created_at,m.id`,
      [tenantA, sessionIdA, phone]
    )).rows;
    expect(messages.map((row) => row.content).sort()).toEqual(["Primeira mensagem!", "Segunda mensagem (final)!"]);
    expect(new Set(messages.map((row) => row.external_message_id).filter(Boolean)).size).toBe(2);
  });

  it("perdedor da corrida: deliverOutboxById após entrega não reenvia nem remarca (retorna vazio)", async () => {
    const phone = nextPhone();
    await pool.query("INSERT INTO conversations(tenant_id,session_id,contact_phone) VALUES($1,$2,$3)", [tenantA, sessionIdA, phone]);
    const outcome = await service.handleInbound({
      tenantId: tenantA, sessionId: sessionIdA, contactPhone: phone, text: "robo", externalId: `start-${randomUUID()}`
    });
    expect(outcome?.outboxId).toBeDefined();
    const qualificationId = await qualificationIdFor(tenantA, phone);
    const first = await outboxRows(qualificationId);
    const inlineRow = first.find((row) => row.id === outcome!.outboxId)!;

    const { gateway, texts, releaseFirst } = mockGateway();
    releaseFirst(); // a cancela do mock travaria o 1º sendText
    const inlineId = await new QualificationService().deliverOutboxById(outcome!.outboxId!, gateway);
    expect(inlineId).toBeTruthy();
    expect(texts).toEqual(["Primeira mensagem!"]);
    // Segunda tentativa (já sent): sem reivindicação, sem sendText, sem mudança.
    const second = await new QualificationService().deliverOutboxById(outcome!.outboxId!, gateway);
    expect(second).toBeFalsy();
    expect(texts).toEqual(["Primeira mensagem!"]);
    const after = await outboxRows(qualificationId);
    expect(after.find((row) => row.id === inlineRow.id)!.status).toBe("sent");
    // Drena a mensagem final pendente para não vazar pending para outras suites.
    expect(await service.pumpOutbox(gateway)).toBe(1);
  });
});
