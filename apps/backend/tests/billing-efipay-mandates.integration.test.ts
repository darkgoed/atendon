import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import {
  firstDueOnFrom,
  getMonthlyPixMandate,
  setEfiPixMandateOverridesForTests,
  startMonthlyPixMandate,
  stopMonthlyPixMandate,
} from "../src/billing/efipay-mandates.js";
import { encryptCredentials } from "../src/billing/providers/credentials.js";
import type { EfiTransport, EfiTransportRequest, EfiTransportResponse } from "../src/billing/providers/efipay-pix-automatic.js";

/**
 * Mandato Pix Automático (Efí) — jornada de opt-in real contra Postgres, com a
 * API da Efí por transport falso (o cliente real, como em produção):
 * - portões: provider habilitado/conectado em produção + credenciais e
 *   documento do titular (nunca ecoado em erro/retorno);
 * - criação: loc + rec remotos, vencimento inicial (mês seguinte, ≥10 dias),
 *   QR na consulta, opt-in registrado em audit_logs;
 * - idempotência/concorrência: unique parcial + lock por tenant — segundo
 *   start NUNCA reenvia POST /v2/rec; recuperação de CREATING sem idRec não
 *   toca a Efí;
 * - sincronia: PENDING só vira APPROVED com GET autenticado devolvendo APROVADA;
 * - stop fail-closed: CANCELLED local, cobranças futuras canceladas na Efí
 *   (pagamentos intactos), falha de cancelamento não conclui o stop.
 */
const runId = randomUUID().slice(0, 8);
const ACTOR = randomUUID(); // consent_actor_user_id — único por execução
const CPF = "45164632481"; // documento de teste (exemplo dos docs Efí)
const TENANT_NAME = "Mandato Teste LTDA";
const QR = "00020126180014br.gov.bcb.pix5204000053039865802BR5913Fulano de Tal6008BRASILIA630462C9";
const LOCATION_ID = 4242;

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const providerCode = `efipay-mandate-${runId}`;
const disabledProviderCode = `efipay-mandate-off-${runId}`;
let providerId = "";
const tenants: string[] = [];

const fake = {
  requests: [] as EfiTransportRequest[],
  remoteRecStatus: "CRIADA",
  chargeStatusOnGet: "ATIVA",
  failCancel: false,
};

const transport: EfiTransport = async (request): Promise<EfiTransportResponse> => {
  fake.requests.push(request);
  if (request.path === "/oauth/token") {
    return { statusCode: 200, text: JSON.stringify({ access_token: "mandate-token", token_type: "Bearer", expires_in: 3600 }) };
  }
  if (request.method === "POST" && request.path === "/v2/locrec") {
    return { statusCode: 201, text: JSON.stringify({ id: LOCATION_ID, location: "pix.example.com/qr/v2/rec/loc-4242" }) };
  }
  if (request.method === "POST" && request.path === "/v2/rec") {
    // idRec único por criação: recriar (stop + start) não colide com a unique.
    const idRec = `RN${randomUUID().replaceAll("-", "")}${randomUUID().replaceAll("-", "")}`.slice(0, 29);
    return { statusCode: 201, text: JSON.stringify({ idRec, status: "CRIADA" }) };
  }
  const recMatch = request.path.match(/^\/v2\/rec\/([A-Za-z0-9]+)$/);
  if (request.method === "GET" && recMatch) {
    return { statusCode: 200, text: JSON.stringify({ idRec: recMatch[1], status: fake.remoteRecStatus, dadosQR: { jornada: "JORNADA_2", pixCopiaECola: QR } }) };
  }
  const cobrMatch = request.path.match(/^\/v2\/cobr\/([A-Za-z0-9]+)$/);
  if (cobrMatch) {
    if (request.method === "PATCH") {
      if (fake.failCancel) return { statusCode: 400, text: JSON.stringify({ title: "Operação inválida." }) };
      return { statusCode: 200, text: JSON.stringify({ txid: cobrMatch[1], status: "CANCELADA" }) };
    }
    if (request.method === "GET") {
      return { statusCode: 200, text: JSON.stringify({ txid: cobrMatch[1], status: fake.chargeStatusOnGet }) };
    }
  }
  return { statusCode: 404, text: JSON.stringify({ title: "not found" }) };
};

function requestsOf(method: string, path: string): EfiTransportRequest[] {
  return fake.requests.filter((request) => request.method === method && request.path === path);
}

async function catchError(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the promise to reject");
}

async function newTenant(options: { document?: string | null } = {}): Promise<string> {
  const id = randomUUID();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const tenant = (await client.query<{ id: string }>(
      "INSERT INTO tenants(name,slug,status) VALUES($1,$2,'active') RETURNING id", [TENANT_NAME, `efipay-mandate-${id}`])).rows[0].id;
    tenants.push(tenant);
    await client.query(
      "INSERT INTO billing_accounts(tenant_id,provider_id,document,email) VALUES($1,$2,$3,$4)",
      [tenant, providerId, options.document === undefined ? CPF : options.document, `${id}@mandate.test`]);
    await client.query("COMMIT");
    return tenant;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function mandateRow(tenantId: string): Promise<Record<string, unknown> | undefined> {
  return (await pool.query(
    "SELECT id,status,external_id_rec,location_id,to_char(first_due_on,'YYYY-MM-DD') AS first_due_on,consent_actor_user_id,approved_at,cancelled_at,credits,price_cents FROM ai_credit_pix_mandates WHERE tenant_id=$1", [tenantId])).rows[0];
}

async function insertStuckCreatingMandate(tenantId: string): Promise<string> {
  // Simula queda no meio da criação remota: CREATING, sem idRec nem location.
  const r = await pool.query<{ id: string }>(
    `INSERT INTO ai_credit_pix_mandates(tenant_id,provider_id,status,first_due_on,consent_actor_user_id,credits,price_cents)
     VALUES($1,$2,'CREATING',CURRENT_DATE+30,$3,50000000,15700) RETURNING id`, [tenantId, providerId, ACTOR]);
  return r.rows[0].id;
}

const futureDate = (days: number): string => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
const txidFor = (seed: string): string => seed.replaceAll("-", "").slice(-26); // cauda carrega o sufixo distinto (txid é global único)

async function insertCharge(mandateId: string, txid: string, dueOn: string, status = "PENDING", invoiceId?: string): Promise<string> {
  const r = await pool.query<{ id: string }>(
    "INSERT INTO ai_credit_pix_charges(mandate_id,due_on,txid,status,invoice_id) VALUES($1,$2::date,$3,$4,$5) RETURNING id",
    [mandateId, dueOn, txid, status, invoiceId ?? null]);
  return r.rows[0].id;
}

beforeAll(async () => {
  await pool.query("SELECT 1");
  await pool.query("INSERT INTO users(id,email,status) VALUES($1,$2,'active') ON CONFLICT (id) DO NOTHING", [ACTOR, `${ACTOR}@efipay-mandates.test`]);
  const credentials = encryptCredentials(
    { clientId: "mandate-client-id", clientSecret: "mandate-client-secret", certificateP12Base64: Buffer.from("fake-p12").toString("base64") },
    config.DATA_ENCRYPTION_KEY);
  providerId = (await pool.query<{ id: string }>(
    `INSERT INTO billing_providers(code,name,enabled,environment,status,accepted_methods,credentials_encrypted,homologated)
     VALUES($1,'Efí (mandato test)',true,'production','CONNECTED',ARRAY['pix_automatic'],$2,true) RETURNING id`,
    [providerCode, credentials])).rows[0].id;
  // Provider dedicado DESLIGADO, para provar o portão sem tocar as linhas globais.
  await pool.query(
    `INSERT INTO billing_providers(code,name,enabled,environment,status,accepted_methods,credentials_encrypted)
     VALUES($1,'Efí desligada (test)',false,'production','NOT_CONFIGURED',ARRAY['pix_automatic'],NULL)`,
    [disabledProviderCode]);
});

beforeEach(() => {
  fake.requests = [];
  fake.remoteRecStatus = "CRIADA";
  fake.chargeStatusOnGet = "ATIVA";
  fake.failCancel = false;
  setEfiPixMandateOverridesForTests({ providerCode, transport });
});

afterEach(() => {
  setEfiPixMandateOverridesForTests(undefined);
});

afterAll(async () => {
  // Auditoria sai antes (resource_id não tem FK; workspace_id vira NULL no delete).
  await pool.query("DELETE FROM audit_logs WHERE actor_user_id=$1", [ACTOR]);
  await pool.query("DELETE FROM tenants WHERE slug LIKE 'efipay-mandate-%'"); // cascata: accounts, mandatos, cobranças, faturas
  await pool.query("DELETE FROM billing_providers WHERE code LIKE 'efipay-mandate-%'");
  await pool.query("DELETE FROM users WHERE id=$1", [ACTOR]);
  await pool.end();
});

describe("firstDueOnFrom", () => {
  it("devolve o 1º dia do mês seguinte quando ele já está a 10+ dias", () => {
    expect(firstDueOnFrom(new Date("2026-09-10T12:00:00Z"))).toBe("2026-10-01");
    expect(firstDueOnFrom(new Date("2026-10-01T00:00:00Z"))).toBe("2026-11-01");
  });

  it("empurra para hoje+10 quando o dia 1 do mês seguinte chega antes disso", () => {
    expect(firstDueOnFrom(new Date("2026-09-25T12:00:00Z"))).toBe("2026-10-05");
    expect(firstDueOnFrom(new Date("2026-10-31T12:00:00Z"))).toBe("2026-11-10");
  });

  it("nunca devolve data a menos de 10 dias ou fora do mês seguinte", () => {
    for (const day of [1, 15, 22, 28, 30]) {
      const due = new Date(`${firstDueOnFrom(new Date(Date.UTC(2026, 8, day, 12)))}T00:00:00Z`);

      expect(due.getTime()).toBeGreaterThanOrEqual(Date.UTC(2026, 8, day + 10));
      expect(due.getUTCMonth()).toBe(9); // outubro
    }
  });
});

describe("startMonthlyPixMandate", () => {
  it("recusa provider Efí desligado, sem chamar a API", async () => {
    setEfiPixMandateOverridesForTests({ providerCode: disabledProviderCode, transport });
    const tenant = await newTenant();
    const error = await catchError(startMonthlyPixMandate(tenant, ACTOR));
    expect(error.message).toMatch(/não está habilitada e conectada em produção/);
    expect(fake.requests).toHaveLength(0);
    expect(await mandateRow(tenant)).toBeUndefined();
  });

  it("recusa sem documento do titular e nunca ecoa o documento", async () => {
    const tenant = await newTenant({ document: "451.646" }); // dígitos insuficientes
    const error = await catchError(startMonthlyPixMandate(tenant, ACTOR));
    expect(error.message).toMatch(/documento do titular/);
    expect(error.message).not.toContain("451646");
    expect(fake.requests).toHaveLength(0);
    expect(await mandateRow(tenant)).toBeUndefined();
  });

  it("cria loc+rec remotos, grava PENDING e devolve QR com vencimento válido", async () => {
    const tenant = await newTenant();
    const result = await startMonthlyPixMandate(tenant, ACTOR);

    // Vencimento independente do módulo: mês seguinte e >= 10 dias no futuro.
    const now = new Date();
    const due = new Date(`${result.firstDueOn}T00:00:00Z`);
    expect(due.getTime()).toBeGreaterThanOrEqual(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 10));
    expect(due.getUTCFullYear() * 12 + due.getUTCMonth()).toBe(now.getUTCFullYear() * 12 + now.getUTCMonth() + 1);

    expect(result.status).toBe("PENDING");
    expect(result.pixCopiaECola).toBe(QR);
    expect(JSON.stringify(result)).not.toContain(CPF);

    const oauth = requestsOf("POST", "/oauth/token");
    expect(oauth).toHaveLength(1);
    expect(oauth[0].headers.Authorization).toMatch(/^Basic /);
    const recBody = JSON.parse(requestsOf("POST", "/v2/rec")[0].body ?? "{}") as {
      loc: number;
      calendario: { dataInicial: string; periodicidade: string };
      valor: { valorRec: string };
      vinculo: { contrato: string; objeto: string; devedor: { nome: string; cpf: string } };
    };
    expect(recBody.loc).toBe(LOCATION_ID);
    expect(recBody.calendario).toEqual({ dataInicial: result.firstDueOn, periodicidade: "MENSAL" });
    expect(recBody.valor).toEqual({ valorRec: "157.00" });
    expect(recBody.vinculo.devedor).toEqual({ nome: TENANT_NAME, cpf: CPF });
    expect(recBody.vinculo.contrato).toBe(result.id.replace(/-/g, ""));
    expect(recBody.vinculo.objeto).toBe(
      "Assinatura mensal do pacote de 50 milhões de créditos de IA (R$ 157,00/mês)");
    expect(requestsOf("GET", `/v2/rec/${(await mandateRow(tenant))?.external_id_rec}`)).toHaveLength(1);

    const row = await mandateRow(tenant);
    expect(row).toMatchObject({
      status: "PENDING",
      external_id_rec: expect.any(String),
      location_id: String(LOCATION_ID),
      consent_actor_user_id: ACTOR,
      credits: "50000000",
      price_cents: "15700",
    });
    expect(row?.first_due_on).toBe(result.firstDueOn);
    const auditRows = await pool.query<{ action: string }>(
      "SELECT action FROM audit_logs WHERE workspace_id=$1 AND resource_type='ai_credit_pix_mandate'", [tenant]);
    expect(auditRows.rows.map((r) => r.action)).toEqual(["PIX_MANDATE_STARTED"]);
  });

  it("segundo start não reenvia /v2/rec: devolve o mesmo mandato sincronizado", async () => {
    const tenant = await newTenant();
    const first = await startMonthlyPixMandate(tenant, ACTOR);
    const recPosts = requestsOf("POST", "/v2/rec").length;

    const second = await startMonthlyPixMandate(tenant, ACTOR);
    expect(second).toMatchObject({ id: first.id, status: "PENDING", firstDueOn: first.firstDueOn, pixCopiaECola: QR });
    expect(requestsOf("POST", "/v2/rec")).toHaveLength(recPosts); // nenhum reenvio
  });

  it("recuperação de CREATING sem idRec não reenvia criação remota", async () => {
    const tenant = await newTenant();
    const stuckId = await insertStuckCreatingMandate(tenant);

    const result = await startMonthlyPixMandate(tenant, ACTOR);
    expect(result).toMatchObject({ id: stuckId, status: "CREATING", pixCopiaECola: null });
    expect(fake.requests).toHaveLength(0); // nem loc, nem rec, nem consulta
    expect((await mandateRow(tenant))?.status).toBe("CREATING");
  });

  it("start concorrente cria um único mandato remoto", async () => {
    const tenant = await newTenant();
    const [a, b] = await Promise.all([startMonthlyPixMandate(tenant, ACTOR), startMonthlyPixMandate(tenant, ACTOR)]);

    const rows = await pool.query<{ id: string }>("SELECT id FROM ai_credit_pix_mandates WHERE tenant_id=$1", [tenant]);
    expect(rows.rows).toHaveLength(1);
    expect(a.id).toBe(b.id);
    expect(a.id).toBe(rows.rows[0].id);
    expect(requestsOf("POST", "/v2/rec")).toHaveLength(1);
  });
});

describe("getMonthlyPixMandate", () => {
  it("devolve null sem mandato ativo; CREATING sem idRec consulta só o banco", async () => {
    const tenant = await newTenant();
    expect(await getMonthlyPixMandate(tenant)).toBeNull();

    const stuckId = await insertStuckCreatingMandate(tenant);
    const before = requestsOf("GET", "").length;
    const view = await getMonthlyPixMandate(tenant);
    expect(view).toMatchObject({ id: stuckId, status: "CREATING", pixCopiaECola: null });
    expect(fake.requests.slice(before)).toHaveLength(0);
  });

  it("só promove PENDING→APPROVED com GET autenticado devolvendo APROVADA", async () => {
    const tenant = await newTenant();
    await startMonthlyPixMandate(tenant, ACTOR);

    const pending = await getMonthlyPixMandate(tenant); // Efí responde CRIADA
    expect(pending).toMatchObject({ status: "PENDING", pixCopiaECola: QR });
    expect((await mandateRow(tenant))?.approved_at ?? null).toBeNull();

    fake.remoteRecStatus = "APROVADA";
    const approved = await getMonthlyPixMandate(tenant);
    expect(approved?.status).toBe("APPROVED");
    const row = await mandateRow(tenant);
    expect(row?.status).toBe("APPROVED");
    expect(row?.approved_at ?? null).not.toBeNull();
  });
});

describe("stopMonthlyPixMandate", () => {
  it("sem mandato ativo devolve null", async () => {
    const tenant = await newTenant();
    expect(await stopMonthlyPixMandate(tenant, ACTOR)).toBeNull();
    expect(fake.requests).toHaveLength(0);
  });

  it("para mandato PENDING sem tocar a Efí; slot é liberado para um novo start", async () => {
    const tenant = await newTenant();
    await startMonthlyPixMandate(tenant, ACTOR);

    const stopped = await stopMonthlyPixMandate(tenant, ACTOR);
    expect(stopped).toMatchObject({ status: "CANCELLED", pixCopiaECola: null });
    const row = await mandateRow(tenant);
    expect(row?.status).toBe("CANCELLED");
    expect((row?.cancelled_at ?? null) ?? null).not.toBeNull();
    expect(fake.requests.filter((r) => r.path.startsWith("/v2/cobr"))).toHaveLength(0);
    expect(await getMonthlyPixMandate(tenant)).toBeNull();

    // Mandato cancelado libera o índice parcial: novo start cria outro mandato.
    const restarted = await startMonthlyPixMandate(tenant, ACTOR);
    expect(restarted.id).not.toBe(row?.id);
    expect(restarted.status).toBe("PENDING");
    expect(requestsOf("POST", "/v2/rec")).toHaveLength(2);
  });

  it("para APPROVED cancelando cobranças futuras e preservando pagamentos", async () => {
    const tenant = await newTenant();
    const mandate = await startMonthlyPixMandate(tenant, ACTOR);
    await pool.query("UPDATE ai_credit_pix_mandates SET status='APPROVED',approved_at=now() WHERE id=$1", [mandate.id]);
    const paidInvoice = (await pool.query<{ id: string }>(
      "INSERT INTO invoices(tenant_id,kind,amount_cents,currency,status) VALUES($1,'credit_package',15700,'BRL','paid') RETURNING id", [tenant])).rows[0].id;
    await insertCharge(mandate.id, txidFor(`${mandate.id}-paid`), futureDate(-30), "APPROVED", paidInvoice);
    const futureInvoice = (await pool.query<{ id: string }>(
      "INSERT INTO invoices(tenant_id,kind,amount_cents,currency,status) VALUES($1,'credit_package',15700,'BRL','pending') RETURNING id", [tenant])).rows[0].id;
    await insertCharge(mandate.id, txidFor(`${mandate.id}-future`), futureDate(30), "PENDING", futureInvoice);

    const stopped = await stopMonthlyPixMandate(tenant, ACTOR);
    expect(stopped?.status).toBe("CANCELLED");
    // Fatura do ciclo futuro cancelado deixa de estar em aberto.
    expect((await pool.query<{ status: string }>("SELECT status FROM invoices WHERE id=$1", [futureInvoice])).rows[0].status).toBe("cancelled");

    const patch = requestsOf("PATCH", `/v2/cobr/${txidFor(`${mandate.id}-future`)}`);
    expect(patch).toHaveLength(1);
    expect(JSON.parse(patch[0].body ?? "{}")).toEqual({ status: "CANCELADA" });
    expect(fake.requests.filter((r) => r.path === `/v2/cobr/${txidFor(`${mandate.id}-paid`)}`)).toHaveLength(0);

    const charges = await pool.query<{ txid: string; status: string; invoice_id: string | null }>(
      "SELECT txid,status,invoice_id FROM ai_credit_pix_charges WHERE mandate_id=$1 ORDER BY (status<>'APPROVED'), txid", [mandate.id]);
    expect(charges.rows).toEqual([
      { txid: txidFor(`${mandate.id}-paid`), status: "APPROVED", invoice_id: paidInvoice }, // pagamento preservado
      { txid: txidFor(`${mandate.id}-future`), status: "CANCELLED", invoice_id: futureInvoice },
    ]);
    expect((await pool.query<{ status: string }>("SELECT status FROM invoices WHERE id=$1", [paidInvoice])).rows[0].status).toBe("paid");
    const auditRows = await pool.query<{ action: string; metadata: Record<string, unknown> }>(
      "SELECT action,metadata FROM audit_logs WHERE workspace_id=$1 AND action='PIX_MANDATE_STOPPED'", [tenant]);
    expect(auditRows.rows[0]?.metadata).toEqual({ futureCharges: 1 });
  });

  it("cobrança futura criada pelo lote durante a parada: stop não conclui; retry a cancela", async () => {
    const tenant = await newTenant();
    const mandate = await startMonthlyPixMandate(tenant, ACTOR);
    await pool.query("UPDATE ai_credit_pix_mandates SET status='APPROVED',approved_at=now() WHERE id=$1", [mandate.id]);
    await insertCharge(mandate.id, txidFor(`${mandate.id}-f1`), futureDate(30));
    // Lote concorrente: cria a próxima cobrança logo após o snapshot da TX1
    // (simulado no 1º PATCH, que acontece entre a TX1 e a parada final).
    let injected = false;
    const inner = transport;
    setEfiPixMandateOverridesForTests({ providerCode, transport: async (request) => {
      if (!injected && request.method === "PATCH") {
        injected = true;
        await insertCharge(mandate.id, txidFor(`${mandate.id}-f2`), futureDate(60));
      }
      return inner(request);
    } });
    const error = await catchError(stopMonthlyPixMandate(tenant, ACTOR));
    expect(error.message).toMatch(/tente novamente/);
    expect((await mandateRow(tenant))?.status).toBe("APPROVED");

    expect((await stopMonthlyPixMandate(tenant, ACTOR))?.status).toBe("CANCELLED");
    expect(requestsOf("PATCH", `/v2/cobr/${txidFor(`${mandate.id}-f2`)}`)).toHaveLength(1);
    const pending = await pool.query("SELECT 1 FROM ai_credit_pix_charges WHERE mandate_id=$1 AND status='PENDING'", [mandate.id]);
    expect(pending.rowCount).toBe(0);
  });

  it("cobrança futura só local (404 na Efí): stop encerra localmente e o lote nunca a envia", async () => {
    const tenant = await newTenant();
    const mandate = await startMonthlyPixMandate(tenant, ACTOR);
    await pool.query("UPDATE ai_credit_pix_mandates SET status='APPROVED',approved_at=now() WHERE id=$1", [mandate.id]);
    const txid = txidFor(`${mandate.id}-local`);
    await insertCharge(mandate.id, txid, futureDate(30));
    const inner = transport;
    setEfiPixMandateOverridesForTests({ providerCode, transport: async (request) => {
      if (request.path === `/v2/cobr/${txid}`) { fake.requests.push(request); return { statusCode: 404, text: "{}" }; }
      return inner(request);
    } });
    expect((await stopMonthlyPixMandate(tenant, ACTOR))?.status).toBe("CANCELLED");
    const row = await pool.query<{ status: string }>("SELECT status FROM ai_credit_pix_charges WHERE txid=$1", [txid]);
    expect(row.rows[0].status).toBe("CANCELLED");
  });

  it("Efí recusa cancelar cobrança futura: stop falha e não conclui; retry funciona", async () => {
    const tenant = await newTenant();
    const mandate = await startMonthlyPixMandate(tenant, ACTOR);
    await pool.query("UPDATE ai_credit_pix_mandates SET status='APPROVED',approved_at=now() WHERE id=$1", [mandate.id]);
    const chargeId = await insertCharge(mandate.id, txidFor(`${mandate.id}-future`), futureDate(30));

    fake.failCancel = true;
    fake.chargeStatusOnGet = "ATIVA"; // GET confirma: ainda ativa na Efí
    const error = await catchError(stopMonthlyPixMandate(tenant, ACTOR));
    expect(error.message).toMatch(/recusou cancelar a cobrança futura/);
    expect((await mandateRow(tenant))?.status).toBe("APPROVED"); // não concluiu
    expect((await pool.query<{ status: string }>("SELECT status FROM ai_credit_pix_charges WHERE id=$1", [chargeId])).rows[0].status).toBe("PENDING");

    fake.failCancel = false;
    const stopped = await stopMonthlyPixMandate(tenant, ACTOR);
    expect(stopped?.status).toBe("CANCELLED");
    expect((await pool.query<{ status: string }>("SELECT status FROM ai_credit_pix_charges WHERE id=$1", [chargeId])).rows[0].status).toBe("CANCELLED");
  });

  it("cobrança já encerrada na Efí é tolerada (stop anterior interrompido)", async () => {
    const tenant = await newTenant();
    const mandate = await startMonthlyPixMandate(tenant, ACTOR);
    await pool.query("UPDATE ai_credit_pix_mandates SET status='APPROVED',approved_at=now() WHERE id=$1", [mandate.id]);
    const chargeId = await insertCharge(mandate.id, txidFor(`${mandate.id}-future`), futureDate(30));

    fake.failCancel = true;
    fake.chargeStatusOnGet = "CANCELADA"; // já cancelada (stop anterior caiu antes do commit local)
    const stopped = await stopMonthlyPixMandate(tenant, ACTOR);
    expect(stopped?.status).toBe("CANCELLED");
    expect((await pool.query<{ status: string }>("SELECT status FROM ai_credit_pix_charges WHERE id=$1", [chargeId])).rows[0].status).toBe("CANCELLED");
  });

  it("cobrança paga na Efí entre a leitura e o cancelamento não é marcada CANCELLED", async () => {
    const tenant = await newTenant();
    const mandate = await startMonthlyPixMandate(tenant, ACTOR);
    await pool.query("UPDATE ai_credit_pix_mandates SET status='APPROVED',approved_at=now() WHERE id=$1", [mandate.id]);
    const chargeId = await insertCharge(mandate.id, txidFor(`${mandate.id}-future`), futureDate(30));

    fake.failCancel = true;
    fake.chargeStatusOnGet = "CONCLUIDA"; // o pagamento venceu a corrida; webhook que feche
    const stopped = await stopMonthlyPixMandate(tenant, ACTOR);
    expect(stopped?.status).toBe("CANCELLED");
    expect((await pool.query<{ status: string }>("SELECT status FROM ai_credit_pix_charges WHERE id=$1", [chargeId])).rows[0].status).toBe("PENDING");
  });

  it("cobrança com vencimento hoje não é cancelada (PATCH 400); stop conclui", async () => {
    const tenant = await newTenant();
    const mandate = await startMonthlyPixMandate(tenant, ACTOR);
    await pool.query("UPDATE ai_credit_pix_mandates SET status='APPROVED',approved_at=now() WHERE id=$1", [mandate.id]);
    const chargeId = await insertCharge(mandate.id, txidFor(`${mandate.id}-today`), futureDate(0));

    fake.failCancel = true;
    fake.chargeStatusOnGet = "ATIVA"; // se tentasse PATCH, GET confirmaria: ainda ativa
    const stopped = await stopMonthlyPixMandate(tenant, ACTOR);
    expect(stopped?.status).toBe("CANCELLED");
    expect(fake.requests.filter((r) => r.path.startsWith("/v2/cobr"))).toHaveLength(0);
    expect((await pool.query<{ status: string }>("SELECT status FROM ai_credit_pix_charges WHERE id=$1", [chargeId])).rows[0].status).toBe("PENDING");
  });
});
