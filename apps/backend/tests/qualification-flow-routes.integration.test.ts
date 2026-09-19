// SPEC v7 ONDA 2-C — rotas e executor dos fluxos de qualificação: branch/finalize
// (transitions, destino inexistente), interactive (payload na outbox + entrega
// capability-gated via deliverOutbox), roteamento do valor do botão via
// interactiveChoices, flow_versions (snapshot/diff/restore), PATCH
// allowed_role_ids + gating fail-closed do executor, flow-templates (CRUD/409/
// tenancy) e analytics do flow_execution_log.
// app.ts é do orquestrador: os testes usam buildApp() (rotas /qualification/*
// já registradas — NUNCA re-registrar o plugin aqui).
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { hash } from "bcryptjs";
import pg from "pg";
import { z } from "zod";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ensureWorkspaceDefaultRoles } from "../src/auth/rbac.js";
import { createSessionToken } from "../src/auth/session.js";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";
import { flowDefinitionSchema, type FlowDefinition } from "../src/modules/qualification/flow.js";
import { QualificationService } from "../src/modules/qualification/service.js";
import { withTransaction } from "../src/modules/scheduling/service.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const app = buildApp();
const service = new QualificationService();
let tenantQ = ""; // executor (branch/finalize/interactive/gating)
let tenantV = ""; // versions + PATCH allowed_role_ids
let tenantT = ""; // flow-templates
let tenantT2 = ""; // isolamento de tenancy dos templates
let tenantA = ""; // analytics
let sessionIdQ = "";
let ownerQ = "";
let ownerV = "";
let readV = "";
let ownerT = "";
let ownerT2 = "";
let ownerA = "";
let allowRoleId = "";
let nopeRoleId = "";
let gateOnlyRoleId = "";
let memberYesId = "";
let memberNopeId = "";
let memberYes = "";
let memberNope = "";
const cookies = new Map<string, string>();
const testEmails: string[] = [];

let phoneSequence = Number(Date.now().toString().slice(-8));
const nextPhone = (ddd = "11") => `55${ddd}${String(++phoneSequence).slice(-8).padStart(8, "0")}`;

const branchFlowDefinition = {
  start: "Q_TIPO",
  origem: "facebook",
  triggers: { ctwa: false, session_ids: [], keywords: ["robo"] },
  steps: {
    Q_TIPO: {
      kind: "options",
      field: "tipo_negocio",
      question: "Loja ou serviço?",
      options: [{ value: "loja" }, { value: "servico" }],
      transitions: { loja: "B_CHECK", servico: "B_CHECK" }
    },
    B_CHECK: {
      kind: "branch",
      variable_name: "tipo_negocio",
      operator: "eq",
      value: "loja",
      transitions: { yes: "M_LOJA", no: "FZ_OUTRO" }
    },
    M_LOJA: { kind: "message", message: "Perfil de loja!", next: "F_FINAL" },
    F_FINAL: { kind: "final", message: "Obrigado!", classificacao: "Loja qualificada" },
    FZ_OUTRO: { kind: "finalize", end_reason: "perfil_servico" }
  }
} satisfies z.input<typeof flowDefinitionSchema>;

const interactiveFlowDefinition = {
  start: "M_OLA",
  origem: "facebook",
  triggers: { ctwa: false, session_ids: [], keywords: ["robo"] },
  steps: {
    M_OLA: { kind: "message", message: "Olá! Escolha uma opção:", next: "I_MENU" },
    I_MENU: {
      kind: "interactive",
      interactive_type: "buttons",
      message: "Como podemos ajudar?",
      options: [{ value: "Falar com humano" }, { value: "Ver preços" }],
      transitions: { "Falar com humano": "FZ_HUMANO", "Ver preços": "FZ_PRECO" }
    },
    FZ_HUMANO: { kind: "finalize", end_reason: "transferido_humano" },
    FZ_PRECO: { kind: "finalize", end_reason: "precos" }
  }
} satisfies z.input<typeof flowDefinitionSchema>;

const versionsFlowV1 = {
  start: "M1",
  origem: "facebook",
  triggers: { ctwa: false, session_ids: [], keywords: ["versao"] },
  steps: {
    M1: { kind: "message", message: "Olá!", next: "Q1" },
    Q1: {
      kind: "options",
      field: "tipo",
      question: "Loja ou serviço?",
      options: [{ value: "loja" }, { value: "servico" }],
      transitions: { loja: "F_L", servico: "F_S" }
    },
    F_L: { kind: "final", message: "Loja!" },
    F_S: { kind: "final", message: "Serviço!" }
  }
} satisfies z.input<typeof flowDefinitionSchema>;

const versionsFlowV2 = {
  ...versionsFlowV1,
  steps: {
    M1: { kind: "message", message: "Oi, tudo bem?", next: "Q1" },
    Q1: {
      kind: "options",
      field: "tipo",
      question: "Loja ou serviço?",
      options: [{ value: "loja" }, { value: "servico" }],
      transitions: { loja: "B1", servico: "F_S" }
    },
    B1: {
      kind: "branch",
      variable_name: "tipo",
      operator: "eq",
      value: "loja",
      transitions: { yes: "F_L", no: "F_S" }
    },
    F_L: { kind: "final", message: "Loja!" },
    F_S: { kind: "final", message: "Serviço!" }
  }
} satisfies z.input<typeof flowDefinitionSchema>;

const templateDefinition = {
  start: "M1",
  origem: "facebook",
  triggers: { ctwa: false, session_ids: [], keywords: ["template"] },
  steps: {
    M1: { kind: "message", message: "Oi!", next: "F1" },
    F1: { kind: "final", message: "Tchau!" }
  }
} satisfies z.input<typeof flowDefinitionSchema>;

// Definição que o editor/snapshot pode produzir com destino pendente: o schema
// bloqueia em PUT, mas o executor reforça a falha em runtime (defesa em
// profundidade) — exercida direto no walk do executor.
const brokenBranchDefinition = {
  start: "B",
  origem: "facebook",
  triggers: { ctwa: false, session_ids: [], keywords: [] },
  steps: {
    B: {
      kind: "branch",
      variable_name: "tipo_negocio",
      operator: "eq",
      value: "loja",
      transitions: { yes: "INEXISTENTE", no: "FZ" }
    },
    FZ: { kind: "finalize", end_reason: "sem_perfil" }
  }
} as unknown as FlowDefinition;

type WalkContextInput = {
  tenantId: string;
  qualificationId: string;
  leadId: string;
  flowId: string;
  conversationId: string | null;
  sessionId: string;
  contactPhone: string;
  contactJid?: string | null;
  externalId: string;
  timezone: string | null;
};

const walkFlow = (service as unknown as {
  walkFlow: (
    client: PoolClient,
    ctx: WalkContextInput,
    definition: FlowDefinition,
    vars: Record<string, string>,
    fromStepId: string
  ) => Promise<{ stoppedReason: string | null }>;
}).walkFlow.bind(service);

async function cookieFor(userId: string, tenantId: string): Promise<string> {
  const cached = cookies.get(userId);
  if (cached) return cached;
  const email = (await pool.query<{ email: string }>("SELECT email FROM users WHERE id=$1", [userId])).rows[0].email;
  const token = await createSessionToken({
    userId,
    tenantId,
    email,
    isRoot: false,
    rootWorkspaceAccess: false,
    mustChangePassword: false
  });
  const header = `atendon_session=${token}`;
  cookies.set(userId, header);
  return header;
}

async function seedFlow(tenantId: string, id: string, definition: unknown, active = false): Promise<void> {
  await pool.query(
    "INSERT INTO qualification_flows(tenant_id,id,name,active,definition) VALUES($1,$2,$3,$4,$5)",
    [tenantId, id, id, active, definition]
  );
}

async function activateFlow(tenantId: string, id: string): Promise<void> {
  // Dois statements: um único UPDATE com active=(id=$2) pode violar
  // transitoriamente a partial unique (duas linhas ativas durante a varredura).
  await pool.query("UPDATE qualification_flows SET active=false WHERE tenant_id=$1", [tenantId]);
  await pool.query("UPDATE qualification_flows SET active=true WHERE tenant_id=$1 AND id=$2", [tenantId, id]);
}

async function ensureConversation(phone: string): Promise<string> {
  return (await pool.query<{ id: string }>(
    "INSERT INTO conversations(tenant_id,session_id,contact_phone) VALUES($1,$2,$3) RETURNING id",
    [tenantQ, sessionIdQ, phone]
  )).rows[0].id;
}

async function qualificationState(phone: string) {
  return (await pool.query<{ id: string; lead_id: string; current_step: string; status: string; resultado_final: string | null; classificacao: string | null }>(
    `SELECT q.id,q.lead_id,q.current_step,q.status,q.resultado_final,q.classificacao
     FROM scheduling_leads l JOIN lead_qualifications q ON q.lead_id=l.id AND q.tenant_id=l.tenant_id
     WHERE l.tenant_id=$1 AND l.phone=$2`,
    [tenantQ, phone]
  )).rows[0];
}

async function logsFor(tenantId: string, flowId: string, nodeId: string) {
  return (await pool.query<{ kind: string; status: string; detail: Record<string, unknown> }>(
    `SELECT kind,status,detail FROM flow_execution_log
     WHERE tenant_id=$1 AND flow_id=$2 AND node_id=$3 ORDER BY created_at,id`,
    [tenantId, flowId, nodeId]
  )).rows;
}

async function startRobot(phone: string) {
  const conversationId = await ensureConversation(phone);
  const started = await service.handleInbound({
    tenantId: tenantQ, sessionId: sessionIdQ, contactPhone: phone, text: "robo", externalId: `start-${randomUUID()}`
  });
  expect(started?.reply).toBe("Loja ou serviço?\n• loja\n• servico");
  const state = (await qualificationState(phone))!;
  expect(state.current_step).toBe("Q_TIPO");
  return { conversationId, state };
}

async function startInteractive(phone: string) {
  const conversationId = await ensureConversation(phone);
  const started = await service.handleInbound({
    tenantId: tenantQ, sessionId: sessionIdQ, contactPhone: phone, text: "robo", externalId: `start-${randomUUID()}`
  });
  expect(started?.reply).toBe("Olá! Escolha uma opção:");
  const state = (await qualificationState(phone))!;
  expect(state.current_step).toBe("I_MENU");
  return { conversationId, state };
}

async function interactiveOutboxRow(qualificationId: string) {
  return (await pool.query<{
    id: string;
    tenant_id: string;
    qualification_id: string;
    step_id: string;
    session_id: string;
    contact_phone: string;
    contact_jid: string | null;
    message: string;
    inbound_external_id: string;
    message_kind: string;
    interactive_payload: Record<string, unknown> | null;
    status: string;
    external_message_id: string | null;
    last_error: string | null;
  }>(
    `SELECT id,tenant_id,qualification_id,step_id,session_id,contact_phone,contact_jid,message,
            inbound_external_id,message_kind,interactive_payload,status,external_message_id,last_error
     FROM qualification_message_outbox WHERE qualification_id=$1 AND message_kind='interactive'`,
    [qualificationId]
  )).rows[0];
}

beforeAll(async () => {
  await app.ready();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const tenants = await client.query<{ id: string }>(
      `INSERT INTO tenants(name,status) VALUES
        ($1,'active'),($2,'active'),($3,'active'),($4,'active'),($5,'active')
       RETURNING id`,
      [
        `Fluxos W2C exec ${randomUUID()}`,
        `Fluxos W2C vers ${randomUUID()}`,
        `Fluxos W2C tmpl ${randomUUID()}`,
        `Fluxos W2C tmpl2 ${randomUUID()}`,
        `Fluxos W2C anly ${randomUUID()}`
      ]
    );
    [tenantQ, tenantV, tenantT, tenantT2, tenantA] = tenants.rows.map((row) => row.id);
    for (const tenantId of [tenantQ, tenantV, tenantT, tenantT2, tenantA]) {
      await ensureWorkspaceDefaultRoles(client, tenantId);
    }
    sessionIdQ = (await client.query<{ id: string }>(
      "INSERT INTO whatsapp_sessions(tenant_id,channel,status) VALUES($1,'whatsapp','connected') RETURNING id",
      [tenantQ]
    )).rows[0].id;
    const passwordHash = await hash("w2c-password", 4);
    const createUser = async (): Promise<string> => {
      const email = `w2c-${randomUUID()}@test.local`;
      testEmails.push(email);
      return (await client.query<{ id: string }>(
        "INSERT INTO users(email,password_hash,status) VALUES($1,$2,'active') RETURNING id",
        [email, passwordHash]
      )).rows[0].id;
    };
    const addMembership = async (tenantId: string, userId: string, roleId: string): Promise<void> => {
      await client.query(
        "INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at) VALUES($1,$2,$3,'active',now())",
        [tenantId, userId, roleId]
      );
    };
    const roleIdFor = async (tenantId: string, name: string): Promise<string> =>
      (await client.query<{ id: string }>(
        "SELECT id FROM workspace_roles WHERE workspace_id=$1 AND name=$2", [tenantId, name]
      )).rows[0].id;

    ownerQ = await createUser();
    await addMembership(tenantQ, ownerQ, await roleIdFor(tenantQ, "OWNER"));

    ownerV = await createUser();
    await addMembership(tenantV, ownerV, await roleIdFor(tenantV, "OWNER"));
    readV = await createUser();
    const readRoleId = (await client.query<{ id: string }>(
      "INSERT INTO workspace_roles(workspace_id,name,description) VALUES($1,$2,'Leitura W2C') RETURNING id",
      [tenantV, `W2C READ ${randomUUID()}`]
    )).rows[0].id;
    await client.query("INSERT INTO workspace_role_permissions(role_id,permission_key) VALUES($1,'agent.read')", [readRoleId]);
    await addMembership(tenantV, readV, readRoleId);

    ownerT = await createUser();
    await addMembership(tenantT, ownerT, await roleIdFor(tenantT, "OWNER"));
    ownerT2 = await createUser();
    await addMembership(tenantT2, ownerT2, await roleIdFor(tenantT2, "OWNER"));
    ownerA = await createUser();
    await addMembership(tenantA, ownerA, await roleIdFor(tenantA, "OWNER"));

    // Papéis e membros para o gating por papel do executor (C1-c).
    allowRoleId = (await client.query<{ id: string }>(
      "INSERT INTO workspace_roles(workspace_id,name,description) VALUES($1,$2,'papel permitido') RETURNING id",
      [tenantQ, `W2C ALLOW ${randomUUID()}`]
    )).rows[0].id;
    nopeRoleId = (await client.query<{ id: string }>(
      "INSERT INTO workspace_roles(workspace_id,name,description) VALUES($1,$2,'papel proibido') RETURNING id",
      [tenantQ, `W2C NOPE ${randomUUID()}`]
    )).rows[0].id;
    gateOnlyRoleId = (await client.query<{ id: string }>(
      "INSERT INTO workspace_roles(workspace_id,name,description) VALUES($1,$2,'papel sem membros') RETURNING id",
      [tenantQ, `W2C GATEONLY ${randomUUID()}`]
    )).rows[0].id;
    memberYes = await createUser();
    await addMembership(tenantQ, memberYes, allowRoleId);
    memberNope = await createUser();
    await addMembership(tenantQ, memberNope, nopeRoleId);
    // assigned_member_id referencia workspace_members.ID (não user_id).
    memberYesId = (await client.query<{ id: string }>(
      "SELECT id FROM workspace_members WHERE workspace_id=$1 AND user_id=$2",
      [tenantQ, memberYes]
    )).rows[0].id;
    memberNopeId = (await client.query<{ id: string }>(
      "SELECT id FROM workspace_members WHERE workspace_id=$1 AND user_id=$2",
      [tenantQ, memberNope]
    )).rows[0].id;

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  await seedFlow(tenantQ, "robot-branch", branchFlowDefinition);
  await seedFlow(tenantQ, "robot-int", interactiveFlowDefinition);
  await seedFlow(tenantQ, "robot-gate", branchFlowDefinition);
  await seedFlow(tenantA, "analytics-flow", templateDefinition);
});

afterAll(async () => {
  await pool.query("DELETE FROM tenants WHERE id=ANY($1::uuid[])", [[tenantQ, tenantV, tenantT, tenantT2, tenantA]]);
  await pool.query("DELETE FROM users WHERE email=ANY($1::text[])", [testEmails]);
  await app.close();
  await pool.end();
});

describe("Executor — branch/finalize/interactive", () => {
  it("branch roteia yes/no por transitions; finalize grava end_reason como resultado_final", async () => {
    await activateFlow(tenantQ, "robot-branch");

    // Ramo yes: pergunta → branch (eq loja) → message → final.
    const yesPhone = nextPhone();
    await startRobot(yesPhone);
    const answeredYes = await service.handleInbound({
      tenantId: tenantQ, sessionId: sessionIdQ, contactPhone: yesPhone, text: "loja", externalId: `ans-${randomUUID()}`
    });
    expect(answeredYes?.reply).toBe("Perfil de loja!");
    const afterYes = (await qualificationState(yesPhone))!;
    expect(afterYes).toMatchObject({ status: "concluido", current_step: "F_FINAL", resultado_final: "F_FINAL", classificacao: "Loja qualificada" });
    const yesBranch = (await logsFor(tenantQ, "robot-branch", "B_CHECK")).filter((row) => row.status === "completed");
    expect(yesBranch[0]).toMatchObject({ kind: "branch" });
    expect(yesBranch[0].detail).toMatchObject({ resultado: "yes", operador: "eq", valor: "loja" });

    // Ramo no: branch → finalize (encerra SEM mensagem; end_reason vira resultado_final).
    const noPhone = nextPhone();
    await startRobot(noPhone);
    const answeredNo = await service.handleInbound({
      tenantId: tenantQ, sessionId: sessionIdQ, contactPhone: noPhone, text: "servico", externalId: `ans-${randomUUID()}`
    });
    expect(answeredNo?.reply).toBeNull();
    const afterNo = (await qualificationState(noPhone))!;
    expect(afterNo).toMatchObject({ status: "concluido", current_step: "FZ_OUTRO", resultado_final: "perfil_servico" });
    const noBranch = (await logsFor(tenantQ, "robot-branch", "B_CHECK")).filter((row) => row.status === "completed");
    expect(noBranch[noBranch.length - 1].detail).toMatchObject({ resultado: "no" });
    const finalizeLogs = await logsFor(tenantQ, "robot-branch", "FZ_OUTRO");
    expect(finalizeLogs.at(-1)).toMatchObject({ kind: "finalize", status: "completed" });
    expect(finalizeLogs.at(-1)!.detail).toMatchObject({ end_reason: "perfil_servico" });
  });

  it("branch com destino inexistente falha explícito (destino_da_condicao_inexistente) no log do executor", async () => {
    await activateFlow(tenantQ, "robot-branch");
    const { state } = await startRobot(nextPhone());
    const walk = await withTransaction((client) => walkFlow(client, {
      tenantId: tenantQ,
      qualificationId: state.id,
      leadId: state.lead_id,
      flowId: "robot-branch",
      conversationId: null,
      sessionId: sessionIdQ,
      contactPhone: "",
      contactJid: null,
      externalId: `walk-${randomUUID()}`,
      timezone: "America/Sao_Paulo"
    }, brokenBranchDefinition, { tipo_negocio: "loja" }, "B"));
    expect(walk.stoppedReason).toBe("missing_step");
    // O walk REAL do fluxo ativo também loga no nó B (completed): pegue a linha
    // FAILED do walk quebrado, não a primeira do log.
    const failure = (await logsFor(tenantQ, "robot-branch", "B")).find((row) => row.status === "failed");
    expect(failure).toMatchObject({ kind: "branch", status: "failed" });
    expect(failure!.detail).toMatchObject({ motivo: "destino_da_condicao_inexistente", resultado: "yes" });
  });

  it("nó interactive enfileira payload na outbox e sai por sendInteractive quando o gateway suporta", async () => {
    await activateFlow(tenantQ, "robot-int");
    const phone = nextPhone();
    const { state } = await startInteractive(phone);
    const row = (await interactiveOutboxRow(state.id))!;
    expect(row.status).toBe("pending");
    expect(row.step_id).toBe("I_MENU");
    expect(row.interactive_payload).toEqual({
      kind: "buttons",
      text: "Como podemos ajudar?",
      buttons: [{ displayText: "Falar com humano" }, { displayText: "Ver preços" }]
    });
    expect(row.message).toContain("Falar com humano");

    const gateway = {
      sendText: vi.fn(),
      sendPresence: vi.fn(),
      markMessageAsRead: vi.fn(),
      setPresence: vi.fn(),
      sendInteractive: vi.fn().mockResolvedValue({ externalId: "int-1" })
    };
    expect(await service.deliverOutbox(row as never, gateway as never)).toBe("int-1");
    expect(gateway.sendText).not.toHaveBeenCalled(); // payload estruturado nunca vira texto
    expect(gateway.sendInteractive).toHaveBeenCalledWith(sessionIdQ, phone, row.interactive_payload);

    const delivered = (await interactiveOutboxRow(state.id))!;
    expect(delivered).toMatchObject({ status: "sent", external_message_id: "int-1", last_error: null });
    const recorded = (await pool.query<{ sender: string; content: string; ai_model_used: string | null; external_message_id: string | null }>(
      "SELECT sender,content,ai_model_used,external_message_id FROM messages WHERE provider_message_key=$1",
      [`${tenantQ}:${sessionIdQ}:int-1`]
    )).rows[0];
    expect(recorded).toMatchObject({ sender: "agent", ai_model_used: "qualification-flow", external_message_id: "int-1" });
    expect(recorded.content).toContain("Falar com humano");
    const deliveredLog = (await logsFor(tenantQ, "robot-int", "I_MENU")).find((row) => row.status === "completed");
    expect(deliveredLog).toMatchObject({ kind: "interactive" });
    expect(deliveredLog!.detail).toMatchObject({ payload_kind: "buttons" });
  });

  it("interactive sem a capability no gateway degrada: failed capability_indisponivel, sem fallback de texto", async () => {
    await activateFlow(tenantQ, "robot-int");
    const phone = nextPhone();
    const { state } = await startInteractive(phone);
    const row = (await interactiveOutboxRow(state.id))!;
    const gateway = {
      sendText: vi.fn().mockResolvedValue({ externalId: "nunca" }),
      sendPresence: vi.fn(),
      markMessageAsRead: vi.fn(),
      setPresence: vi.fn()
    };
    expect(await service.deliverOutbox(row as never, gateway as never)).toBe("");
    expect(gateway.sendText).not.toHaveBeenCalled();
    const failed = (await interactiveOutboxRow(state.id))!;
    expect(failed).toMatchObject({ status: "failed", last_error: "capability_indisponivel" });
    const failedLog = (await logsFor(tenantQ, "robot-int", "I_MENU")).find((entry) => entry.status === "failed");
    expect(failedLog).toMatchObject({ kind: "interactive" });
    expect(failedLog!.detail).toMatchObject({ motivo: "capability_indisponivel" });
  });

  it("inbound roteia o valor do botão via interactiveChoices até o finalize", async () => {
    await activateFlow(tenantQ, "robot-int");
    const phone = nextPhone();
    await startInteractive(phone);
    const answered = await service.handleInbound({
      tenantId: tenantQ, sessionId: sessionIdQ, contactPhone: phone, text: "Ver preços", externalId: `btn-${randomUUID()}`
    });
    expect(answered?.reply).toBeNull(); // finalize não envia mensagem
    const state = (await qualificationState(phone))!;
    expect(state).toMatchObject({ status: "concluido", resultado_final: "precos" });
    const completed = (await logsFor(tenantQ, "robot-int", "I_MENU"))
      .filter((row) => row.status === "completed" && row.detail && "valor" in row.detail)
      .at(-1);
    expect(completed).toMatchObject({ kind: "interactive" });
    expect(completed!.detail).toMatchObject({ valor: "Ver preços" });
  });
});

describe("Gating por allowed_role_ids (C1-c, fail-closed)", () => {
  it("PATCH exige agent.manage, valida papéis da organização (400) e fluxo inexistente (404)", async () => {
    // Papéis do MESMO tenant do fluxo (a validação é por organização). Flow
    // próprio p/ este teste — "versoes" fica limpo p/ o describe de versions.
    await seedFlow(tenantV, "versoes-patch", {});
    const allowGroupId = (await pool.query<{ id: string }>(
      "INSERT INTO workspace_roles(workspace_id,name) VALUES($1,$2) RETURNING id",
      [tenantV, `W2C V-ALLOW ${randomUUID()}`]
    )).rows[0].id;
    const denyGroupId = (await pool.query<{ id: string }>(
      "INSERT INTO workspace_roles(workspace_id,name) VALUES($1,$2) RETURNING id",
      [tenantV, `W2C V-DENY ${randomUUID()}`]
    )).rows[0].id;
    expect((await app.inject({
      method: "PATCH", url: "/qualification/flows/versoes", payload: { allowed_role_ids: [allowRoleId] }
    })).statusCode).toBe(401);
    expect((await app.inject({
      method: "PATCH", url: "/qualification/flows/versoes",
      headers: { cookie: await cookieFor(readV, tenantV) },
      payload: { allowed_role_ids: [] }
    })).statusCode).toBe(403);
    const badRole = await app.inject({
      method: "PATCH", url: "/qualification/flows/versoes",
      headers: { cookie: await cookieFor(ownerV, tenantV) },
      payload: { allowed_role_ids: [randomUUID()] }
    });
    expect(badRole.statusCode).toBe(400);
    expect(badRole.json().error).toContain("não pertencem à organização");
    expect((await app.inject({
      method: "PATCH", url: "/qualification/flows/inexistente",
      headers: { cookie: await cookieFor(ownerV, tenantV) },
      payload: { allowed_role_ids: [] }
    })).statusCode).toBe(404);
    const patched = await app.inject({
      method: "PATCH", url: "/qualification/flows/versoes-patch",
      headers: { cookie: await cookieFor(ownerV, tenantV) },
      payload: { allowed_role_ids: [allowGroupId, denyGroupId] }
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().flow.allowed_role_ids).toEqual([allowGroupId, denyGroupId]);
    const cleared = await app.inject({
      method: "PATCH", url: "/qualification/flows/versoes-patch",
      headers: { cookie: await cookieFor(ownerV, tenantV) },
      payload: { allowed_role_ids: [] }
    });
    expect(cleared.json().flow.allowed_role_ids).toEqual([]);
  });

  it("gate fail-closed: fluxo restrito não começa para lead sem responsável (log gate skipped)", async () => {
    const patched = await app.inject({
      method: "PATCH", url: "/qualification/flows/robot-gate",
      headers: { cookie: await cookieFor(ownerQ, tenantQ) },
      payload: { allowed_role_ids: [gateOnlyRoleId] } // papel sem nenhum membro
    });
    expect(patched.statusCode).toBe(200);
    await activateFlow(tenantQ, "robot-gate");
    const phone = nextPhone();
    await ensureConversation(phone);
    expect(await service.handleInbound({
      tenantId: tenantQ, sessionId: sessionIdQ, contactPhone: phone, text: "robo", externalId: `gate-${randomUUID()}`
    })).toBeNull();
    expect(await qualificationState(phone)).toBeUndefined();
    const gateLog = (await logsFor(tenantQ, "robot-gate", "Q_TIPO")).at(-1)!;
    expect(gateLog).toMatchObject({ kind: "gate", status: "skipped" });
    expect(gateLog.detail).toMatchObject({ motivo: "role_not_allowed" });
  });

  it("em andamento: papel errado registra skipped e cala o robô; papel do responsável roda; sem responsável bloqueia", async () => {
    // Qualificações iniciadas ANTES da restrição (allowlist vazia).
    await activateFlow(tenantQ, "robot-branch");
    await app.inject({
      method: "PATCH", url: "/qualification/flows/robot-branch",
      headers: { cookie: await cookieFor(ownerQ, tenantQ) },
      payload: { allowed_role_ids: [] }
    });
    const restrictedPhone = nextPhone();
    await startRobot(restrictedPhone);
    const orphanPhone = nextPhone();
    await startRobot(orphanPhone);

    await app.inject({
      method: "PATCH", url: "/qualification/flows/robot-branch",
      headers: { cookie: await cookieFor(ownerQ, tenantQ) },
      payload: { allowed_role_ids: [allowRoleId] }
    });

    // Papel fora da allowlist: robô calado + log skipped role_not_allowed.
    let restricted = (await qualificationState(restrictedPhone))!;
    await pool.query("UPDATE scheduling_leads SET assigned_member_id=$2 WHERE id=$1", [restricted.lead_id, memberNopeId]);
    expect(await service.handleInbound({
      tenantId: tenantQ, sessionId: sessionIdQ, contactPhone: restrictedPhone, text: "loja", externalId: `blocked-${randomUUID()}`
    })).toBeNull();
    restricted = (await qualificationState(restrictedPhone))!;
    expect(restricted.current_step).toBe("Q_TIPO"); // estado inalterado
    const skipped = (await logsFor(tenantQ, "robot-branch", "Q_TIPO")).filter((row) => row.status === "skipped").at(-1)!;
    expect(skipped).toMatchObject({ kind: "options" });
    expect(skipped.detail).toMatchObject({ motivo: "role_not_allowed" });

    // Responsável com papel da allowlist: executor roda até o final.
    await pool.query("UPDATE scheduling_leads SET assigned_member_id=$2 WHERE id=$1", [restricted.lead_id, memberYesId]);
    const allowed = await service.handleInbound({
      tenantId: tenantQ, sessionId: sessionIdQ, contactPhone: restrictedPhone, text: "loja", externalId: `allowed-${randomUUID()}`
    });
    expect(allowed?.reply).toBe("Perfil de loja!");
    expect((await qualificationState(restrictedPhone))!).toMatchObject({ status: "concluido", resultado_final: "F_FINAL" });

    // Sem responsável: fail-closed (bloqueado), estado preservado.
    await pool.query("UPDATE scheduling_leads SET assigned_member_id=NULL WHERE id=$1", [(await qualificationState(orphanPhone))!.lead_id]);
    expect(await service.handleInbound({
      tenantId: tenantQ, sessionId: sessionIdQ, contactPhone: orphanPhone, text: "loja", externalId: `orphan-${randomUUID()}`
    })).toBeNull();
    expect((await qualificationState(orphanPhone))!.current_step).toBe("Q_TIPO");
    const orphanSkipped = (await logsFor(tenantQ, "robot-branch", "Q_TIPO")).filter((row) => row.status === "skipped").at(-1)!;
    expect(orphanSkipped.detail).toMatchObject({ motivo: "role_not_allowed" });
  });
});

describe("Versions — snapshot, diff e restore (C1-b)", () => {
  it("PUT cria versão por salvamento; GET lista; diff aponta added/removed/modified/edges; restore repõe a definição em versão nova", async () => {
    const cookie = await cookieFor(ownerV, tenantV);
    expect((await app.inject({ method: "GET", url: "/qualification/flows/versoes/versions" })).statusCode).toBe(401);
    const first = await app.inject({
      method: "PUT", url: "/qualification/flows/versoes", headers: { cookie },
      payload: { nome: "Versões", ativo: true, definition: versionsFlowV1 }
    });
    expect(first.statusCode).toBe(201);
    const second = await app.inject({
      method: "PUT", url: "/qualification/flows/versoes", headers: { cookie },
      payload: { nome: "Versões", ativo: true, definition: versionsFlowV2 }
    });
    expect(second.statusCode).toBe(200);

    const listed = await app.inject({ method: "GET", url: "/qualification/flows/versoes/versions", headers: { cookie } });
    expect(listed.statusCode).toBe(200);
    const versions = listed.json().versions;
    expect(versions.map((version: { version: number }) => version.version)).toEqual([2, 1]);
    expect(versions[0]).toMatchObject({ flow_name: "Versões", created_by: ownerV });
    expect(versions[1].id).toBeTruthy();

    const diff = await app.inject({
      method: "GET", url: "/qualification/flows/versoes/versions/diff?from=1&to=2", headers: { cookie }
    });
    expect(diff.statusCode).toBe(200);
    const body = diff.json();
    expect(body.diff.added).toEqual(["B1"]);
    expect(body.diff.removed).toEqual([]);
    expect(body.diff.modified).toEqual(expect.arrayContaining(["M1", "Q1"]));
    expect(body.diff.edges.added).toEqual(expect.arrayContaining([
      { from: "Q1", to: "B1", label: "loja" },
      { from: "B1", to: "F_L", label: "yes" },
      { from: "B1", to: "F_S", label: "no" }
    ]));
    expect(body.diff.edges.removed).toEqual([{ from: "Q1", to: "F_L", label: "loja" }]);
    expect((await app.inject({
      method: "GET", url: "/qualification/flows/versoes/versions/diff?from=1&to=99", headers: { cookie }
    })).statusCode).toBe(404);

    const restore = await app.inject({
      method: "POST", url: `/qualification/flows/versoes/versions/${versions[1].id}/restore`, headers: { cookie }
    });
    expect(restore.statusCode).toBe(200);
    expect(restore.json()).toMatchObject({ restored_from: 1, version: 3 });
    expect(restore.json().flow.definition.steps.M1.message).toBe("Olá!");
    expect(restore.json().flow.definition.steps.B1).toBeUndefined();
    const afterRestore = await app.inject({ method: "GET", url: "/qualification/flows/versoes/versions", headers: { cookie } });
    expect(afterRestore.json().versions.map((version: { version: number }) => version.version)).toEqual([3, 2, 1]);

    expect((await app.inject({
      method: "POST", url: `/qualification/flows/versoes/versions/${randomUUID()}/restore`, headers: { cookie }
    })).statusCode).toBe(404);
    expect((await app.inject({
      method: "GET", url: "/qualification/flows/versoes/versions", headers: { cookie: await cookieFor(readV, tenantV) }
    })).statusCode).toBe(200);
  });
});

describe("flow-templates — CRUD, conflito de nome e tenancy (C1-f)", () => {
  it("cria, lista, lê, atualiza e exclui; nome duplicado vira 409; definição inválida vira 400", async () => {
    const cookie = await cookieFor(ownerT, tenantT);
    expect((await app.inject({
      method: "POST", url: "/qualification/flow-templates", payload: { name: "X", definition: templateDefinition }
    })).statusCode).toBe(401);
    expect((await app.inject({
      method: "POST", url: "/qualification/flow-templates",
      headers: { cookie: await cookieFor(readV, tenantV) },
      payload: { name: "X", definition: templateDefinition }
    })).statusCode).toBe(403);

    const created = await app.inject({
      method: "POST", url: "/qualification/flow-templates", headers: { cookie },
      payload: { name: "Onboarding W2C", description: "Fluxo base", definition: templateDefinition }
    });
    expect(created.statusCode).toBe(201);
    const template = created.json().template;
    expect(template).toMatchObject({ nome: "Onboarding W2C", descricao: "Fluxo base" });
    expect(template.definition.steps.M1.message).toBe("Oi!");
    const templateId = template.id as string;

    const listed = await app.inject({ method: "GET", url: "/qualification/flow-templates", headers: { cookie } });
    expect(listed.json().templates.map((row: { id: string }) => row.id)).toContain(templateId);
    const single = await app.inject({ method: "GET", url: `/qualification/flow-templates/${templateId}`, headers: { cookie } });
    expect(single.json().template.definition.steps.F1.message).toBe("Tchau!");

    const duplicated = await app.inject({
      method: "POST", url: "/qualification/flow-templates", headers: { cookie },
      payload: { name: "Onboarding W2C", definition: templateDefinition }
    });
    expect(duplicated.statusCode).toBe(409);
    expect(duplicated.json().error).toContain("Já existe um template");

    const updated = await app.inject({
      method: "PUT", url: `/qualification/flow-templates/${templateId}`, headers: { cookie },
      payload: { name: "Onboarding W2C v2" }
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().template).toMatchObject({ nome: "Onboarding W2C v2", descricao: "Fluxo base" });
    expect((await app.inject({
      method: "PUT", url: `/qualification/flow-templates/${templateId}`, headers: { cookie },
      payload: {
        definition: {
          start: "B", origem: "facebook", triggers: { ctwa: false, session_ids: [], keywords: [] },
          steps: {
            B: { kind: "branch", variable_name: "x", operator: "eq", transitions: { yes: "F", no: "F" } },
            F: { kind: "finalize", end_reason: "x" }
          }
        }
      }
    })).statusCode).toBe(400); // branch sem value
    expect((await app.inject({
      method: "PUT", url: `/qualification/flow-templates/${templateId}`, headers: { cookie },
      payload: { definition: templateDefinition }
    })).statusCode).toBe(200);

    expect((await app.inject({ method: "DELETE", url: `/qualification/flow-templates/${templateId}`, headers: { cookie } })).statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: `/qualification/flow-templates/${templateId}`, headers: { cookie } })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: `/qualification/flow-templates/${templateId}`, headers: { cookie } })).statusCode).toBe(404);
  });

  it("tenancy: template do tenant T não vaza para T2; unicidade de nome é por tenant", async () => {
    const cookieT = await cookieFor(ownerT, tenantT);
    const cookieT2 = await cookieFor(ownerT2, tenantT2);
    const created = await app.inject({
      method: "POST", url: "/qualification/flow-templates", headers: { cookie: cookieT },
      payload: { name: "Compartilhado", definition: templateDefinition }
    });
    expect(created.statusCode).toBe(201);
    const templateId = created.json().template.id as string;

    const listedT2 = await app.inject({ method: "GET", url: "/qualification/flow-templates", headers: { cookie: cookieT2 } });
    expect(listedT2.json().templates.map((row: { id: string }) => row.id)).not.toContain(templateId);
    expect((await app.inject({ method: "GET", url: `/qualification/flow-templates/${templateId}`, headers: { cookie: cookieT2 } })).statusCode).toBe(404);

    const sameNameOtherTenant = await app.inject({
      method: "POST", url: "/qualification/flow-templates", headers: { cookie: cookieT2 },
      payload: { name: "Compartilhado", definition: templateDefinition }
    });
    expect(sameNameOtherTenant.statusCode).toBe(201);
  });
});

describe("analytics (C1-d)", () => {
  it("agrega executions/completed/errors do flow_execution_log por fluxo", async () => {
    await pool.query(
      `INSERT INTO flow_execution_log(tenant_id,flow_id,lead_id,node_id,kind,status,detail) VALUES
        ($1,'analytics-flow',$2,'F1','final','completed','{}'),
        ($1,'analytics-flow',$3,'F1','final','completed','{}'),
        ($1,'analytics-flow',$3,'A1','action','failed','{}'),
        ($1,'analytics-flow',$4,'FZ','finalize','completed','{}')`,
      [tenantA, randomUUID(), randomUUID(), randomUUID()]
    );
    expect((await app.inject({ method: "GET", url: "/qualification/flows/analytics-flow/analytics" })).statusCode).toBe(401);
    const response = await app.inject({
      method: "GET", url: "/qualification/flows/analytics-flow/analytics", headers: { cookie: await cookieFor(ownerA, tenantA) }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ executions: 3, completed: 3, errors: 1 });
    expect((await app.inject({
      method: "GET", url: "/qualification/flows/inexistente/analytics", headers: { cookie: await cookieFor(ownerA, tenantA) }
    })).statusCode).toBe(404);
  });
});
