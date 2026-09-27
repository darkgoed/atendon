import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { config } from "../src/config.js";
import { seedTenantCapabilities } from "./helpers/capability-seed.js";
import { QualificationService } from "../src/modules/qualification/service.js";
import { acquireSharedProviderLock, QUALIFICATION_OUTBOX_LOCK_KEY, SHARED_PROVIDER_LOCK_TIMEOUT_MS } from "./helpers/shared-provider-lock.js";
import { WhatsAppSendRejectedError } from "../src/modules/whatsapp/errors.js";

// pumpOutbox do robô é GLOBAL: em paralelo, uma suíte entrega (e marca como
// enviadas) as mensagens pendentes da outra.
let releaseQualificationOutboxLock: (() => Promise<void>) | undefined;
beforeAll(async () => { releaseQualificationOutboxLock = await acquireSharedProviderLock(QUALIFICATION_OUTBOX_LOCK_KEY); }, SHARED_PROVIDER_LOCK_TIMEOUT_MS);
afterAll(async () => { await releaseQualificationOutboxLock?.(); });

// Auditoria P1 (fluxos de robô): laço de espera (F1) e reinício com etapa
// inicial não-pergunta (F2).
const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const service = new QualificationService();
let tenantId = "";
let sessionId = "";
let phoneSequence = Number(Date.now().toString().slice(-8));
const nextPhone = () => `5511${String(++phoneSequence).slice(-8).padStart(8, "0")}`;

async function useFlow(definition: Record<string, unknown>) {
  await pool.query(
    "UPDATE qualification_flows SET definition=$2,active=true,updated_at=now() WHERE tenant_id=$1 AND id='p1-robot'",
    [tenantId, definition]
  );
}

async function startLead(keyword: string) {
  const phone = nextPhone();
  await pool.query("INSERT INTO conversations(tenant_id,session_id,contact_phone) VALUES($1,$2,$3)", [tenantId, sessionId, phone]);
  await service.handleInbound({ tenantId, sessionId, contactPhone: phone, text: keyword, externalId: `ext-${randomUUID()}` });
  const state = (await pool.query<{ id: string; lead_id: string; current_step: string }>(
    `SELECT q.id,q.lead_id,q.current_step FROM scheduling_leads l
     JOIN lead_qualifications q ON q.lead_id=l.id AND q.tenant_id=l.tenant_id
     WHERE l.tenant_id=$1 AND l.phone=$2`, [tenantId, phone]
  )).rows[0];
  return { phone, ...state };
}

async function dueNow(qualificationId: string) {
  await pool.query("UPDATE lead_qualifications SET wait_until=now()-interval '1 second' WHERE id=$1", [qualificationId]);
  return service.processDueWait({ tenantId, qualificationId });
}

async function outbox(qualificationId: string) {
  return (await pool.query<{ step_id: string; message: string; status: string; message_kind: string }>(
    "SELECT step_id,message,status,message_kind FROM qualification_message_outbox WHERE qualification_id=$1 ORDER BY created_at,id",
    [qualificationId]
  )).rows;
}

beforeAll(async () => {
  tenantId = (await pool.query<{ id: string }>("INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id", [`Robô P1 ${randomUUID()}`])).rows[0].id;
  await seedTenantCapabilities(pool, [tenantId]);
  sessionId = (await pool.query<{ id: string }>("INSERT INTO whatsapp_sessions(tenant_id,status) VALUES($1,'connected') RETURNING id", [tenantId])).rows[0].id;
  await pool.query("INSERT INTO qualification_flows(tenant_id,id,name,active,definition) VALUES($1,'p1-robot','Robô P1',false,$2)", [tenantId, {
    start: "Q", origem: "facebook", triggers: { ctwa: false, session_ids: [], keywords: ["p1"] },
    steps: { Q: { kind: "text", field: "instagram", question: "Qual seu Instagram?", next: "F" }, F: { kind: "final", message: "Fim" } }
  }]);
});

afterAll(async () => {
  await pool.query("DELETE FROM tenants WHERE id=$1", [tenantId]);
  await pool.end();
});

describe("auditoria P1 — fluxos de robô", () => {
  it("F1: laço wait_for_reply → message → wait reenvia as mensagens a cada volta", async () => {
    await useFlow({
      start: "W", origem: "facebook", triggers: { ctwa: false, session_ids: [], keywords: ["laco"] },
      steps: {
        W: { kind: "wait_for_reply", timeout_minutes: 1, message: "Me responde?", on_timeout: "M", next: "F" },
        M: { kind: "message", message: "Ainda está aí?", next: "W" },
        F: { kind: "final", message: "Obrigado" }
      }
    });
    const lead = await startLead("laco");
    expect(lead.current_step).toBe("W");
    expect((await dueNow(lead.id)).processed).toBe(true);
    // Primeira volta entregue pelo pump da outbox.
    await pool.query("UPDATE qualification_message_outbox SET status='sent' WHERE qualification_id=$1", [lead.id]);
    expect((await dueNow(lead.id)).processed).toBe(true);
    const rows = await outbox(lead.id);
    // Duas voltas de timeout = duas mensagens M e duas W (além da W inicial);
    // a segunda volta fica pendente de envio — não é engolida pelo ON CONFLICT.
    expect(rows.filter((row) => row.step_id === "M")).toHaveLength(2);
    expect(rows.filter((row) => row.step_id === "W")).toHaveLength(3);
    expect(rows.filter((row) => row.status === "pending").map((row) => row.step_id).sort()).toEqual(["M", "W"]);
  });

  it("F2: reiniciar fluxo cuja etapa inicial é message executa o caminho no próximo inbound", async () => {
    await useFlow({
      start: "M0", origem: "facebook", triggers: { ctwa: false, session_ids: [], keywords: ["reinicio"] },
      steps: {
        M0: { kind: "message", message: "Olá de novo!", next: "Q" },
        Q: { kind: "options", field: "tipo", question: "Produto ou serviço?", options: [{ value: "produto" }, { value: "servico" }], transitions: { produto: "F", servico: "F" } },
        F: { kind: "final", message: "Fim" }
      }
    });
    const lead = await startLead("reinicio");
    expect(lead.current_step).toBe("Q");
    await service.setFlowAction(tenantId, lead.lead_id, "restart");
    const before = (await outbox(lead.id)).length;
    const outcome = await service.handleInbound({ tenantId, sessionId, contactPhone: lead.phone, text: "oi", externalId: `ext-${randomUUID()}` });
    expect(outcome?.reply).toBe("Olá de novo!");
    const after = (await outbox(lead.id)).slice(before);
    expect(after.map((row) => [row.step_id, row.message])).toEqual([["M0", "Olá de novo!"], ["Q", expect.stringContaining("Produto ou serviço?")]]);
    const state = (await pool.query<{ current_step: string; ask_pending: boolean }>("SELECT current_step,ask_pending FROM lead_qualifications WHERE id=$1", [lead.id])).rows[0];
    expect(state).toEqual({ current_step: "Q", ask_pending: false });
    // A resposta seguinte já é aceita pela pergunta (sem loop de "não entendi").
    await service.handleInbound({ tenantId, sessionId, contactPhone: lead.phone, text: "produto", externalId: `ext-${randomUUID()}` });
    expect((await pool.query<{ status: string }>("SELECT status FROM lead_qualifications WHERE id=$1", [lead.id])).rows[0].status).toBe("concluido");
  });

  it("auditoria runtime #4/#5: mensagens do caminho saem em ordem e envio rejeitado não repete para sempre", async () => {
    await useFlow({
      start: "M1", origem: "facebook", triggers: { ctwa: false, session_ids: [], keywords: ["ordem"] },
      steps: {
        M1: { kind: "message", message: "1 - Oi, tudo bem?", next: "M2" },
        M2: { kind: "message", message: "2 - Sou o assistente", next: "F1" },
        F1: { kind: "final", message: "3 - Qual seu nome?" }
      }
    });
    const phone = nextPhone();
    await pool.query("INSERT INTO conversations(tenant_id,session_id,contact_phone) VALUES($1,$2,$3)", [tenantId, sessionId, phone]);
    const outcome = await service.handleInbound({ tenantId, sessionId, contactPhone: phone, text: "ordem", externalId: `ext-${randomUUID()}` });
    expect(outcome?.reply).toBe("1 - Oi, tudo bem?");
    const delivered: string[] = [];
    let rejectFirst = true;
    const gateway = {
      sendText: vi.fn(async (_session: string, to: string, text: string) => {
        if (to !== phone) return { externalId: `other-${randomUUID()}` }; // pump é global: outras conversas do arquivo
        if (rejectFirst && text.startsWith("1")) throw new WhatsAppSendRejectedError("connection closed");
        delivered.push(text);
        return { externalId: `x-${randomUUID()}` };
      })
    };
    // Envio inline da 1ª rejeitado (fica pendente com backoff): o pump não pode adiantar a 2ª e a 3ª.
    await expect(service.deliverOutboxById(outcome!.outboxId!, gateway as never)).rejects.toThrow();
    await service.pumpOutbox(gateway as never);
    expect(delivered).toEqual([]);
    rejectFirst = false;
    await pool.query("UPDATE qualification_message_outbox SET next_attempt_at=now() WHERE id=$1", [outcome!.outboxId]);
    await service.pumpOutbox(gateway as never);
    await service.pumpOutbox(gateway as never);
    await service.pumpOutbox(gateway as never);
    expect(delivered).toEqual(["1 - Oi, tudo bem?", "2 - Sou o assistente", "3 - Qual seu nome?"]);

    // Rejeição persistente: após o teto de tentativas vira falha, sem reenviar dias depois.
    const stale = (await pool.query<{ id: string }>(
      `INSERT INTO qualification_message_outbox(tenant_id,qualification_id,session_id,contact_phone,step_id,inbound_external_id,message_kind,message,attempts,created_at)
       SELECT tenant_id,qualification_id,session_id,contact_phone,'Z',$2,'message','antiga',19,now()-interval '1 hour'
       FROM qualification_message_outbox WHERE id=$1 RETURNING id`, [outcome!.outboxId, `stale-${randomUUID()}`]
    )).rows[0].id;
    const rejecting = { sendText: vi.fn(async () => { throw new WhatsAppSendRejectedError("connection closed"); }) };
    await expect(service.deliverOutboxById(stale, rejecting as never)).rejects.toThrow();
    expect((await pool.query<{ status: string }>("SELECT status FROM qualification_message_outbox WHERE id=$1", [stale])).rows[0].status).toBe("failed");
  });
});

