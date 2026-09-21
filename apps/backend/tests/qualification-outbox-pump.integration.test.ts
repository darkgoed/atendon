// Pump da outbox do robô de fluxos: mensagens 2..N de um walk, retomadas de
// delay (simulando restart — o estado vive no banco) e nós interactive são
// entregues por QualificationService.pumpOutbox. Cobertura:
//   1. message→final: 2ª mensagem pendente sai via sendText e a outbox fica sent
//   2. retomada de delay após "restart": processDueWait + pump entregam a mensagem
//   3. interactive sai por sendInteractive; pump concorrente não duplica (claim)
//   4. isolamento: linha com sessão de outro tenant / sessão arquivada NUNCA sai
// Sem Redis/HTTP: gateway é mock; o resto é banco real (atendon_test).
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
let tenantB = "";
let sessionIdA = "";
let sessionIdB = "";

let phoneSequence = Number(Date.now().toString().slice(-8));
const nextPhone = (ddd = "11") => `55${ddd}${String(++phoneSequence).slice(-8).padStart(8, "0")}`;

const twoMessagesFlow = {
  start: "M1",
  origem: "facebook",
  triggers: { ctwa: false, session_ids: [], keywords: ["robo"] },
  steps: {
    M1: { kind: "message", message: "Primeira mensagem!", next: "F1" },
    F1: { kind: "final", message: "Segunda mensagem (final)!", classificacao: "ok" }
  }
} satisfies z.input<typeof flowDefinitionSchema>;

const delayFlow = {
  start: "Q1",
  origem: "facebook",
  triggers: { ctwa: false, session_ids: [], keywords: ["robo"] },
  steps: {
    Q1: {
      kind: "options",
      field: "tipo",
      question: "Loja ou serviço?",
      options: [{ value: "loja" }],
      transitions: { loja: "D1" }
    },
    D1: { kind: "delay", wait_minutes: 1, next: "M1" },
    M1: { kind: "message", message: "Voltei depois da espera!", next: "F1" },
    F1: { kind: "final", message: "Fim!" }
  }
} satisfies z.input<typeof flowDefinitionSchema>;

const interactiveFlow = {
  start: "M1",
  origem: "facebook",
  triggers: { ctwa: false, session_ids: [], keywords: ["robo"] },
  steps: {
    M1: { kind: "message", message: "Olá!", next: "I1" },
    I1: {
      kind: "interactive",
      interactive_type: "buttons",
      message: "Escolha:",
      options: [{ value: "Falar com humano" }],
      transitions: { "Falar com humano": "FZ1" }
    },
    FZ1: { kind: "finalize", end_reason: "humano" }
  }
} satisfies z.input<typeof flowDefinitionSchema>;

async function seedFlow(tenantId: string, id: string, definition: unknown): Promise<void> {
  // Nasce inativa: uq_qualification_flows_one_active_per_tenant só permite um
  // fluxo ativo por tenant — cada teste ativa o seu (2 statements, ver houses).
  await pool.query(
    "INSERT INTO qualification_flows(tenant_id,id,name,active,definition) VALUES($1,$2,$3,false,$4)",
    [tenantId, id, id, definition]
  );
}

async function activateFlow(tenantId: string, id: string): Promise<void> {
  await pool.query("UPDATE qualification_flows SET active=false WHERE tenant_id=$1", [tenantId]);
  await pool.query("UPDATE qualification_flows SET active=true WHERE tenant_id=$1 AND id=$2", [tenantId, id]);
}

function outboxRows(qualificationId: string) {
  return pool.query<{
    id: string; step_id: string; message_kind: string; status: string;
    external_message_id: string | null; message: string; attempts: number;
  }>(
    `SELECT id,step_id,message_kind,status,external_message_id,message,attempts
     FROM qualification_message_outbox WHERE qualification_id=$1 ORDER BY created_at,id`,
    [qualificationId]
  );
}

function agentMessages(tenantId: string, sessionId: string, phone: string) {
  return pool.query<{ content: string; external_message_id: string | null; ai_model_used: string | null }>(
    `SELECT m.content,m.external_message_id,m.ai_model_used FROM messages m
     JOIN conversations c ON c.id=m.conversation_id
     WHERE c.tenant_id=$1 AND c.session_id=$2 AND c.contact_phone=$3 AND m.sender='agent'
     ORDER BY m.created_at,m.id`,
    [tenantId, sessionId, phone]
  );
}

function mockGateway(): { gateway: MessageGateway; texts: string[]; interactives: () => number } {
  let counter = 0;
  const texts: string[] = [];
  const state = { interactives: 0 };
  const gateway = {
    sendText: vi.fn(async (_sessionId: string, _destination: string, text: string) => {
      texts.push(text);
      return { externalId: `ext-${++counter}` };
    }),
    sendPresence: vi.fn(async () => {}),
    markMessageAsRead: vi.fn(async () => {}),
    setPresence: vi.fn(async () => {}),
    sendInteractive: vi.fn(async () => {
      state.interactives += 1;
      return { externalId: `int-${++counter}` };
    })
  } as unknown as MessageGateway;
  return { gateway, texts, interactives: () => state.interactives };
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
  const tenants = await pool.query<{ id: string }>(
    "INSERT INTO tenants(name,status) VALUES($1,'active'),($2,'active') RETURNING id",
    [`Fluxos pump A ${randomUUID()}`, `Fluxos pump B ${randomUUID()}`]
  );
  [tenantA, tenantB] = tenants.rows.map((row) => row.id);
  sessionIdA = (await pool.query<{ id: string }>(
    "INSERT INTO whatsapp_sessions(tenant_id,channel,status) VALUES($1,'whatsapp','connected') RETURNING id",
    [tenantA]
  )).rows[0].id;
  sessionIdB = (await pool.query<{ id: string }>(
    "INSERT INTO whatsapp_sessions(tenant_id,channel,status) VALUES($1,'whatsapp','connected') RETURNING id",
    [tenantB]
  )).rows[0].id;
  await seedFlow(tenantA, "pump-two-msgs", twoMessagesFlow);
  await seedFlow(tenantA, "pump-delay", delayFlow);
  await seedFlow(tenantA, "pump-interactive", interactiveFlow);
});

afterAll(async () => {
  await pool.query("DELETE FROM tenants WHERE id=ANY($1::uuid[])", [[tenantA, tenantB]]);
  await pool.end();
});

describe("QualificationService.pumpOutbox", () => {
  it("entrega a 2ª mensagem de um walk (message→final) que não vai inline", async () => {
    await activateFlow(tenantA, "pump-two-msgs");
    const phone = nextPhone();
    await pool.query("INSERT INTO conversations(tenant_id,session_id,contact_phone) VALUES($1,$2,$3)", [tenantA, sessionIdA, phone]);
    const started = await service.handleInbound({
      tenantId: tenantA, sessionId: sessionIdA, contactPhone: phone, text: "robo", externalId: `start-${randomUUID()}`
    });
    expect(started?.reply).toBe("Primeira mensagem!"); // 1ª inline; 2ª fica na outbox
    const qualificationId = await qualificationIdFor(tenantA, phone);
    const before = (await outboxRows(qualificationId)).rows;
    expect(before).toHaveLength(2);
    expect(before.find((row) => row.step_id === "F1")?.status).toBe("pending");

    const { gateway, texts } = mockGateway();
    const delivered = await service.pumpOutbox(gateway);
    expect(delivered).toBeGreaterThanOrEqual(2);
    expect(texts).toContain("Primeira mensagem!");
    expect(texts).toContain("Segunda mensagem (final)!");

    const after = (await outboxRows(qualificationId)).rows;
    for (const row of after) expect(row.status).toBe("sent");
    const messages = (await agentMessages(tenantA, sessionIdA, phone)).rows;
    expect(messages.map((row) => row.content)).toEqual(expect.arrayContaining(["Primeira mensagem!", "Segunda mensagem (final)!"]));
    for (const row of messages) expect(row.ai_model_used ?? "qualification-flow").toBe("qualification-flow");
  });

  it("retomada de delay sobrevive a restart: estado no banco + pump entrega a mensagem proativa", async () => {
    await activateFlow(tenantA, "pump-delay");
    const phone = nextPhone();
    await pool.query("INSERT INTO conversations(tenant_id,session_id,contact_phone) VALUES($1,$2,$3)", [tenantA, sessionIdA, phone]);
    await service.handleInbound({
      tenantId: tenantA, sessionId: sessionIdA, contactPhone: phone, text: "robo", externalId: `start-${randomUUID()}`
    });
    const answered = await service.handleInbound({
      tenantId: tenantA, sessionId: sessionIdA, contactPhone: phone, text: "loja", externalId: `ans-${randomUUID()}`
    });
    expect(answered?.reply).toBeNull(); // caiu no delay
    const qualificationId = await qualificationIdFor(tenantA, phone);
    const waiting = (await pool.query<{ wait_until: Date | null }>(
      "SELECT wait_until FROM lead_qualifications WHERE id=$1", [qualificationId]
    )).rows[0];
    expect(waiting.wait_until).not.toBeNull();

    // "Restart": nada em memória — reconciliador lê o estado vencido do banco.
    await pool.query("UPDATE lead_qualifications SET wait_until=now()-interval '1 second' WHERE id=$1", [qualificationId]);
    const resumed = await service.processDueWait({ tenantId: tenantA, qualificationId });
    expect(resumed.processed).toBe(true);

    const pending = (await outboxRows(qualificationId)).rows.filter((row) => row.status === "pending");
    expect(pending.map((row) => row.message)).toEqual(expect.arrayContaining(["Voltei depois da espera!", "Fim!"]));

    const { gateway, texts } = mockGateway();
    expect(await service.pumpOutbox(gateway)).toBeGreaterThanOrEqual(2);
    expect(texts).toEqual(expect.arrayContaining(["Voltei depois da espera!", "Fim!"]));
    expect((await outboxRows(qualificationId)).rows.every((row) => row.status === "sent")).toBe(true);
  });

  it("nó interactive sai por sendInteractive e pump concorrente não duplica entrega", async () => {
    await activateFlow(tenantA, "pump-interactive");
    const phone = nextPhone();
    await pool.query("INSERT INTO conversations(tenant_id,session_id,contact_phone) VALUES($1,$2,$3)", [tenantA, sessionIdA, phone]);
    await service.handleInbound({
      tenantId: tenantA, sessionId: sessionIdA, contactPhone: phone, text: "robo", externalId: `start-${randomUUID()}`
    });
    const qualificationId = await qualificationIdFor(tenantA, phone);
    const pending = (await outboxRows(qualificationId)).rows.filter((row) => row.message_kind === "interactive");
    expect(pending).toHaveLength(1);

    const { gateway, interactives } = mockGateway();
    // Dois pumps em paralelo (dois workers/pod): o claim por claimed_at/status
    // garante no máximo uma entrega por linha.
    const [a, b] = await Promise.all([
      service.pumpOutbox(gateway),
      service.pumpOutbox(gateway)
    ]);
    expect(interactives()).toBe(1);
    expect(a + b).toBeGreaterThanOrEqual(1);
    const rows = (await outboxRows(qualificationId)).rows;
    expect(rows.filter((row) => row.message_kind === "interactive")[0].status).toBe("sent");
    expect((await pool.query(
      "SELECT 1 FROM messages WHERE provider_message_key LIKE $1 AND sender='agent'",
      [`${tenantA}:${sessionIdA}:int-%`]
    )).rowCount).toBe(1);
  });

  it("nunca entrega linha com sessão de outro tenant ou sessão arquivada (isolamento no pump)", async () => {
    await activateFlow(tenantA, "pump-two-msgs");
    const phone = nextPhone();
    await pool.query("INSERT INTO conversations(tenant_id,session_id,contact_phone) VALUES($1,$2,$3)", [tenantB, sessionIdB, phone]);
    await service.handleInbound({
      tenantId: tenantB, sessionId: sessionIdB, contactPhone: phone, text: "robo", externalId: `start-${randomUUID()}`
    }).catch(() => null); // tenant B não tem fluxo ativo — ok, só precisamos do lead/conversa
    const qualificationB = await pool.query<{ id: string }>(
      `SELECT q.id FROM lead_qualifications q WHERE q.tenant_id=$1 LIMIT 1`, [tenantB]
    );
    expect(qualificationB.rows[0]).toBeUndefined(); // sem fluxo em B, nada a entreguar

    // Fluxo em A para ter uma qualificação real e injetar linhas armadilha.
    const phoneA = nextPhone();
    await pool.query("INSERT INTO conversations(tenant_id,session_id,contact_phone) VALUES($1,$2,$3)", [tenantA, sessionIdA, phoneA]);
    await service.handleInbound({
      tenantId: tenantA, sessionId: sessionIdA, contactPhone: phoneA, text: "robo", externalId: `start-${randomUUID()}`
    });
    const qualificationA = await qualificationIdFor(tenantA, phoneA);

    // 1) Cross-tenant é IMPOSSÍVEL por FK: qualification_message_outbox_
    //    session_tenant_fkey (0064) exige (tenant_id,session_id) ∈ whatsapp_
    //    sessions(tenant_id,id) — tentativa viola a constraint. Prova:
    await expect(pool.query(
      `INSERT INTO qualification_message_outbox
         (tenant_id,qualification_id,session_id,contact_phone,step_id,inbound_external_id,message_kind,message)
       VALUES($1,$2,$3,$4,'X1','leak-1','message','vazamento cross-tenant')`,
      [tenantA, qualificationA, sessionIdB, phoneA]
    )).rejects.toThrow(/session_tenant_fkey/u);
    // 2) sessão arquivada do PRÓPRIO tenant: pump não entrega (EXISTS channel/
    //    archived_at) — linha fica pending para reintegração quando reativar.
    const archivedSessionA = (await pool.query<{ id: string }>(
      "INSERT INTO whatsapp_sessions(tenant_id,channel,status) VALUES($1,'whatsapp','connected') RETURNING id",
      [tenantA]
    )).rows[0].id;
    await pool.query("UPDATE whatsapp_sessions SET archived_at=now() WHERE id=$1", [archivedSessionA]);
    await pool.query(
      `INSERT INTO qualification_message_outbox
         (tenant_id,qualification_id,session_id,contact_phone,step_id,inbound_external_id,message_kind,message)
       VALUES($1,$2,$3,$4,'X2','arch-1','message','sessão arquivada')`,
      [tenantA, qualificationA, archivedSessionA, phoneA]
    );

    const { gateway, texts } = mockGateway();
    await service.pumpOutbox(gateway);
    expect(texts).not.toContain("vazamento cross-tenant");
    expect(texts).not.toContain("sessão arquivada");
    const traps = await pool.query<{ inbound_external_id: string; status: string }>(
      "SELECT inbound_external_id,status FROM qualification_message_outbox WHERE qualification_id=$1 AND step_id='X2'",
      [qualificationA]
    );
    expect(traps.rows).toHaveLength(1);
    for (const row of traps.rows) expect(row.status).toBe("pending");
  });
});

describe("E2E — webhook duplicado, contatos simultâneos e isolamento", () => {
  it("webhook duplicado (mesmo externalId) devolve a MESMA mensagem e não duplica a outbox (retomada pós-crash)", async () => {
    await activateFlow(tenantA, "pump-two-msgs");
    const phone = nextPhone();
    await pool.query("INSERT INTO conversations(tenant_id,session_id,contact_phone) VALUES($1,$2,$3)", [tenantA, sessionIdA, phone]);
    const externalId = `dup-${randomUUID()}`;
    const first = await service.handleInbound({
      tenantId: tenantA, sessionId: sessionIdA, contactPhone: phone, text: "robo", externalId
    });
    expect(first?.reply).toBe("Primeira mensagem!");
    // Redelivery do webhook (ex.: BullMQ retry após crash antes de markInboundProcessed):
    // last_inbound_external_id casa → devolve uma das pendências do walk (a mais
    // recente em empate de created_at) e NÃO enfileira nada de novo.
    const second = await service.handleInbound({
      tenantId: tenantA, sessionId: sessionIdA, contactPhone: phone, text: "robo", externalId
    });
    expect(second?.reply).toBe("Primeira mensagem!");
    const qualificationId = await qualificationIdFor(tenantA, phone);
    const rows = await pool.query<{ inbound_external_id: string }>(
      "SELECT inbound_external_id FROM qualification_message_outbox WHERE qualification_id=$1",
      [qualificationId]
    );
    const dupRows = rows.rows.filter((row) => row.inbound_external_id === externalId);
    expect(dupRows).toHaveLength(2); // M1 + F1 — uma por etapa do walk, sem duplicatas
  });

  it("múltiplos contatos simultâneos progridem de forma independente (sem contaminação de estado)", async () => {
    await activateFlow(tenantA, "pump-delay");
    const phones = [nextPhone(), nextPhone(), nextPhone()];
    for (const phone of phones) {
      await pool.query("INSERT INTO conversations(tenant_id,session_id,contact_phone) VALUES($1,$2,$3)", [tenantA, sessionIdA, phone]);
    }
    // Início concorrente dos 3 contatos (mesmo fluxo, mesma sessão).
    const starts = await Promise.all(phones.map((phone) =>
      service.handleInbound({ tenantId: tenantA, sessionId: sessionIdA, contactPhone: phone, text: "robo", externalId: `start-${randomUUID()}` })
    ));
    for (const reply of starts) expect(reply?.reply).toBe("Loja ou serviço?\n• loja");

    // Resposta concorrente de todos → cada um cai no SEU delay.
    const answers = await Promise.all(phones.map((phone) =>
      service.handleInbound({ tenantId: tenantA, sessionId: sessionIdA, contactPhone: phone, text: "loja", externalId: `ans-${randomUUID()}` })
    ));
    for (const reply of answers) expect(reply?.reply).toBeNull();

    // Um contato respondeu de novo (aguardando delay): mensagem NÃO antecipa retomada...
    const duringDelay = await service.handleInbound({
      tenantId: tenantA, sessionId: sessionIdA, contactPhone: phones[0], text: "oi de novo", externalId: `x-${randomUUID()}`
    });
    expect(duringDelay?.reply).toBeNull();

    // Estados separados: 3 qualificações, cada lead com o seu wait_until.
    const states = await pool.query<{ phone: string; current_step: string; status: string }>(
      `SELECT l.phone,q.current_step,q.status FROM lead_qualifications q
       JOIN scheduling_leads l ON l.id=q.lead_id AND l.tenant_id=q.tenant_id
       WHERE q.tenant_id=$1 AND l.phone=ANY($2::text[])`,
      [tenantA, phones]
    );
    expect(states.rows).toHaveLength(3);
    for (const row of states.rows) {
      expect(row).toMatchObject({ current_step: "D1", status: "em_andamento" });
    }
  });

  it("isolamento de tenant no motor: sessionId de outro tenant NUNCA dispara/consome fluxo", async () => {
    await activateFlow(tenantA, "pump-two-msgs");
    const phoneB = nextPhone();
    await pool.query("INSERT INTO conversations(tenant_id,session_id,contact_phone) VALUES($1,$2,$3)", [tenantB, sessionIdB, phoneB]);
    // Chamador mente o tenantId (B) com a sessão do tenant A: a lookup de canal
    // exige s.tenant_id=$2 — nenhuma linha, motor nem liga (null → turno de IA).
    const outcome = await service.handleInbound({
      tenantId: tenantB, sessionId: sessionIdA, contactPhone: phoneB, text: "robo", externalId: `leak-${randomUUID()}`
    });
    expect(outcome).toBeNull();
    const leaked = await pool.query<{ id: string }>(
      `SELECT 1 FROM lead_qualifications q
       JOIN scheduling_leads l ON l.id=q.lead_id AND l.tenant_id=q.tenant_id
       WHERE q.tenant_id=$1 AND l.phone=$2`,
      [tenantA, phoneB]
    );
    expect(leaked.rowCount).toBe(0);
  });
});
