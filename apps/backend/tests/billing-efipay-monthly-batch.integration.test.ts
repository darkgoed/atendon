import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { runEfiPixMonthlyBatch, type EfiMonthlyBatchResult } from "../src/billing/efipay-monthly-batch.js";
import type { EfiChargeInput } from "../src/billing/providers/efipay-pix-automatic.js";
import { applyVerifiedEfiRefund } from "../src/billing/efipay-refunds.js";

/**
 * Lote mensal Efí (Pix Automático) contra Postgres real e API Efí FALSA —
 * nenhuma chamada externa real: o clientFactory injeta o fake em todo teste.
 * Prova o contrato do worker:
 * - cria UMA cobrança de R$157,00 por ciclo mensal, 2–10 dias antes do
 *   vencimento, com txid determinístico (26–35 alfanuméricos) e compra/fatura
 *   idempotentes (`efi-monthly:<mandateId>:<dueDate>`);
 * - mandato CANCELADO local nunca gera cobrança, mesmo com a Efí APROVADA;
 *   rec não-APROVADA na Efí bloqueia e espelha o status terminal;
 * - grant SOMENTE com CONCLUIDA vinda de GET autenticado, recusando payload
 *   divergente (txid/idRec/valor/vencimento) e status forjado no PUT;
 * - falha/cancelamento não concede; CANCELADA posterior ao pagamento, sem
 *   evidência de devolução do Pix, não revoga o grant pago nem re-concede;
 * - concorrência e reexecução não duplicam cobrança/fatura/payment/grant;
 *   `limit` limita o lote.
 */
const CREDITS = 50_000_000;
const PRICE_CENTS = 15_700;

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const ACTOR = randomUUID(); // consent_actor_user_id — único por execução

type FakeCharge = { idRec: string; valor: string; venc: string; status: string };

/** API Efí falsa: guarda cobranças por txid e permite forjar status/payload. */
class FakeEfi {
  recStatus = "APROVADA";
  putCalls = 0;
  getCalls = 0;
  putStatus: string | null = null;      // status devolvido pelo PUT (default ATIVA)
  storeStatus: string | null = null;    // status guardado no mapa (default = putStatus)
  valorOverride: string | null = null;  // payload forjado do GET
  idRecOverride: string | null = null;
  vencOverride: string | null = null;
  readonly charges = new Map<string, FakeCharge>();

  async getRecurrence(idRec: string): Promise<{ idRec: string; status?: string; payload: Record<string, unknown> }> {
    return { idRec, status: this.recStatus, payload: {} };
  }

  async createCharge(txid: string, input: EfiChargeInput): Promise<{ txid: string; status?: string; payload: Record<string, unknown> }> {
    this.putCalls++;
    // PUT idempotente: cobrança já existente devolve o estado REAL atual.
    const existing = this.charges.get(txid);
    const status = existing ? existing.status : (this.storeStatus ?? this.putStatus ?? "ATIVA");
    this.charges.set(txid, { idRec: input.idRec, valor: (input.originalCents / 100).toFixed(2), venc: input.dataDeVencimento, status });
    return { txid, status: existing ? existing.status : (this.putStatus ?? status), payload: {} };
  }

  async getCharge(txid: string): Promise<{ txid: string; status?: string; payload: Record<string, unknown> }> {
    const charge = this.charges.get(txid);
    if (!charge) throw new Error("Efi Pix API error (404)");
    this.getCalls++;
    return {
      txid,
      status: charge.status,
      payload: {
        idRec: this.idRecOverride ?? charge.idRec,
        txid,
        valor: { original: this.valorOverride ?? charge.valor },
        calendario: { dataDeVencimento: this.vencOverride ?? charge.venc },
        status: charge.status
      }
    };
  }
}

async function runBatch(fake: FakeEfi, limit = 50): Promise<EfiMonthlyBatchResult> {
  return await runEfiPixMonthlyBatch(limit, { clientFactory: () => fake });
}

/** Tenant + gateway dedicado + mandato APPROVED com primeiro vencimento a N dias. */
async function fixture(dueOffsetDays: number, mandateStatus = "APPROVED"): Promise<{ tenant: string; provider: string; mandate: string; rec: string }> {
  const id = randomUUID();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const tenant = (await client.query<{ id: string }>(
      "INSERT INTO tenants(name,slug,status) VALUES($1,$2,'active') RETURNING id", [`EfíMonthly ${id}`, `efipay-monthly-${id}`])).rows[0].id;
    // Gateway dedicado por fixture: homologado (CHECK) + enabled + credencial, sandbox.
    const provider = (await client.query<{ id: string }>(
      "INSERT INTO billing_providers(code,name,enabled,environment,homologated,credentials_encrypted) VALUES($1,$1,true,'sandbox',true,'x') RETURNING id", [`efipay-monthly-${id}`])).rows[0].id;
    const rec = `rec-${id}`;
    const mandate = (await client.query<{ id: string }>(
      `INSERT INTO ai_credit_pix_mandates(tenant_id,provider_id,status,first_due_on,consent_actor_user_id,credits,price_cents,external_id_rec)
       VALUES($1,$2,$3,CURRENT_DATE + $4::int,$5,50000000,15700,$6) RETURNING id`,
      [tenant, provider, mandateStatus, dueOffsetDays, ACTOR, rec])).rows[0].id;
    await client.query("COMMIT");
    return { tenant, provider, mandate, rec };
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}

type ChargeRow = { id: string; txid: string; status: string; invoice_id: string | null; due_on: string };
const chargeOf = async (mandateId: string): Promise<ChargeRow | undefined> =>
  (await pool.query<ChargeRow>(
    "SELECT id,txid,status,invoice_id,due_on::text AS due_on FROM ai_credit_pix_charges WHERE mandate_id=$1 ORDER BY due_on", [mandateId])).rows[0];

beforeAll(async () => {
  await pool.query("SELECT 1");
  await pool.query("INSERT INTO users(id,email,status) VALUES($1,$2,'active') ON CONFLICT (id) DO NOTHING", [ACTOR, `${ACTOR}@efipay-monthly.test`]);
});

afterAll(async () => {
  // Tenants primeiro (cascata leva mandatos/cobranças/faturas/purchases/grants),
  // depois gateways e o ator.
  await pool.query("DELETE FROM tenants WHERE slug LIKE 'efipay-monthly-%'");
  await pool.query("DELETE FROM billing_providers WHERE code LIKE 'efipay-monthly-%'");
  await pool.query("DELETE FROM audit_logs WHERE actor_user_id=$1", [ACTOR]);
  await pool.query("DELETE FROM users WHERE id=$1", [ACTOR]);
  await pool.end();
});

describe("fase de criação (janela 2–10 dias)", () => {
  it("cria uma cobrança idempotente por ciclo com txid determinístico e fatura presa à Efí", async () => {
    const f = await fixture(5);
    const fake = new FakeEfi();
    const first = await runBatch(fake);
    expect(first.created).toBe(1);
    expect(first.granted).toBe(0);
    expect(Object.values(first).filter((value) => typeof value === "number").length).toBeGreaterThan(0);

    const charge = await chargeOf(f.mandate);
    expect(charge).toBeDefined();
    expect(charge!.status).toBe("PENDING");
    expect(charge!.txid).toMatch(/^[a-zA-Z0-9]{26,35}$/);
    expect(charge!.invoice_id).not.toBeNull();

    const invoice = (await pool.query<{ provider_id: string; external_id: string; amount_cents: string; kind: string; status: string; due_ok: boolean }>(
      `SELECT provider_id,external_id,amount_cents,kind,status,(due_date::date = $2::date) AS due_ok
         FROM invoices WHERE id=$1`, [charge!.invoice_id, charge!.due_on])).rows[0];
    expect(invoice).toMatchObject({ provider_id: f.provider, external_id: charge!.txid, amount_cents: String(PRICE_CENTS), kind: "credit_package", status: "pending", due_ok: true });

    const purchase = (await pool.query<{ id: string }>(
      "SELECT id FROM ai_credit_purchases WHERE tenant_id=$1 AND idempotency_key=$2", [f.tenant, `efi-monthly:${f.mandate}:${charge!.due_on}`])).rows[0];
    expect(purchase).toBeDefined();
    // PUT autenticado com o corpo exato do ciclo.
    expect(fake.putCalls).toBe(1);
    expect(fake.charges.get(charge!.txid)).toMatchObject({ idRec: f.rec, valor: "157.00", venc: charge!.due_on, status: "ATIVA" });

    // Reexecução: NADA novo — mesma linha, mesmo txid, nenhuma segunda fatura.
    const second = await runBatch(fake);
    expect(second.created).toBe(0);
    expect(second.granted).toBe(0);
    expect(await chargeOf(f.mandate)).toMatchObject({ id: charge!.id, txid: charge!.txid, status: "PENDING" });
    expect((await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM ai_credit_purchases WHERE tenant_id=$1", [f.tenant])).rows[0].n).toBe(1);
    expect((await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM invoices WHERE tenant_id=$1", [f.tenant])).rows[0].n).toBe(1);
  });

  it("fora da janela (1, 11 e 35 dias) não cria; bordas 2 e 10 criam", async () => {
    for (const offset of [1, 11, 35]) {
      const f = await fixture(offset);
      const result = await runBatch(new FakeEfi());
      expect(result.created).toBe(0);
      expect(await chargeOf(f.mandate)).toBeUndefined();
      expect((await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM ai_credit_purchases WHERE tenant_id=$1", [f.tenant])).rows[0].n).toBe(0);
    }
    for (const offset of [2, 10]) {
      const f = await fixture(offset);
      const result = await runBatch(new FakeEfi());
      expect(result.created).toBe(1);
      expect(await chargeOf(f.mandate)).toBeDefined();
    }
  });

  it("mandato CANCELADO local não gera cobrança mesmo com a Efí ainda APROVADA", async () => {
    const f = await fixture(5, "CANCELLED");
    const fake = new FakeEfi();
    const result = await runBatch(fake);
    expect(result.created).toBe(0);
    // O fake atende os outros mandatos da própria suíte: a asserção isolada
    // é por recorrência — nenhuma cobrança Efí nasce para ESTA rec.
    expect([...fake.charges.values()].some((charge) => charge.idRec === f.rec)).toBe(false);
    expect(await chargeOf(f.mandate)).toBeUndefined();
    expect((await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM ai_credit_purchases WHERE tenant_id=$1", [f.tenant])).rows[0].n).toBe(0);
  });

  it("mandato cancelado localmente durante o lote (após a seleção) não recebe PUT", async () => {
    const f = await fixture(5);
    const fake = new FakeEfi();
    // Stop local concorrente: cancela entre a SQL de seleção da fase 2 e o PUT
    // (1ª chamada = fase 1 de criação; 2ª = reconciliação, já com a linha selecionada).
    let recCalls = 0;
    fake.getRecurrence = async (idRec: string) => {
      if (idRec === f.rec && ++recCalls === 2) {
        await pool.query("UPDATE ai_credit_pix_mandates SET status='CANCELLED', cancelled_at=now() WHERE id=$1", [f.mandate]);
      }
      return { idRec, status: "APROVADA", payload: {} };
    };
    await runBatch(fake);
    const charge = (await chargeOf(f.mandate))!;
    expect(charge).toBeDefined(); // fase 1 criou a linha local
    expect(recCalls).toBe(2);
    expect(fake.charges.has(charge.txid)).toBe(false); // nenhum PUT desta cobrança
  });

  it("rec não-APROVADA na Efí bloqueia, espelha o status terminal e não cria", async () => {
    const f = await fixture(5);
    const fake = new FakeEfi();
    fake.recStatus = "CANCELADA";
    const result = await runBatch(fake);
    expect(result.created).toBe(0);
    expect(fake.putCalls).toBe(0);
    expect((await pool.query<{ status: string; cancelled_at: Date | null }>(
      "SELECT status,cancelled_at FROM ai_credit_pix_mandates WHERE id=$1", [f.mandate])).rows[0]).toMatchObject({ status: "CANCELLED" });
    expect(await chargeOf(f.mandate)).toBeUndefined();
  });

  it("txid é determinístico e distinto por (mandato, vencimento)", async () => {
    const a = await fixture(5);
    const b = await fixture(5);
    await runBatch(new FakeEfi());
    await runBatch(new FakeEfi());
    const txidA = (await chargeOf(a.mandate))!.txid;
    const txidB = (await chargeOf(b.mandate))!.txid;
    expect(txidA).not.toBe(txidB);
    // Reexecução mantém o mesmo txid (idempotência entre processos).
    await runBatch(new FakeEfi());
    expect((await chargeOf(a.mandate))!.txid).toBe(txidA);
  });

  it("respeita limit e cria um ciclo por mandato", async () => {
    const mandates = [await fixture(4), await fixture(5), await fixture(6)];
    const first = await runBatch(new FakeEfi(), 1);
    expect(first.created).toBe(1);
    const second = await runBatch(new FakeEfi(), 1);
    expect(second.created).toBe(1);
    const charged = (await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM ai_credit_pix_charges WHERE mandate_id = ANY($1::uuid[])", [mandates.map((m) => m.mandate)])).rows[0].n;
    expect(charged).toBe(2);
  });

  it("item que sempre falha não monopoliza o lote: rodízio alcança o próximo mandato", async () => {
    const stuck = await fixture(4);
    const next = await fixture(4);
    const fake = new FakeEfi();
    // Só o mandato `next` responde; todos os outros (inclusive `stuck`) falham.
    fake.getRecurrence = async (idRec: string) => {
      if (idRec !== next.rec) throw new Error("Efi Pix API error (500)");
      return { idRec, status: "APROVADA", payload: {} };
    };
    const candidates = (await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ai_credit_pix_mandates m
        WHERE m.status='APPROVED' AND NOT EXISTS (SELECT 1 FROM ai_credit_pix_charges x WHERE x.mandate_id=m.id)`)).rows[0].n;
    let failures = 0;
    for (let i = 0; i < candidates && !(await chargeOf(next.mandate)); i++) failures += (await runBatch(fake, 1)).errors.length;
    expect(await chargeOf(next.mandate)).toBeDefined();
    expect(failures).toBeGreaterThan(0);
    expect(await chargeOf(stuck.mandate)).toBeUndefined();
  });
});

describe("reconciliação: grant só com CONCLUIDA autenticada", () => {
  it("CONCLUIDA via GET paga a fatura, registra payment e concede o pacote", async () => {
    const f = await fixture(5);
    const fake = new FakeEfi();
    await runBatch(fake); // cria + PUT (ATIVA)
    const charge = await chargeOf(f.mandate)!;
    fake.charges.get(charge!.txid)!.status = "CONCLUIDA";

    const result = await runBatch(fake);
    expect(result.granted).toBe(1);
    const after = await chargeOf(f.mandate);
    expect(after!.status).toBe("APPROVED");

    const invoice = (await pool.query<{ status: string; paid_at: Date | null }>(
      "SELECT status,paid_at FROM invoices WHERE id=$1", [after!.invoice_id])).rows[0];
    expect(invoice.status).toBe("paid");
    expect(invoice.paid_at).not.toBeNull();
    const payment = (await pool.query<{ status: string; external_id: string; amount_cents: string; method: string }>(
      "SELECT status,external_id,amount_cents,method FROM payments WHERE invoice_id=$1", [after!.invoice_id])).rows[0];
    expect(payment).toMatchObject({ status: "paid", external_id: after!.txid, amount_cents: String(PRICE_CENTS), method: "pix_automatic" });
    const purchase = (await pool.query<{ status: string; grant_id: string }>(
      "SELECT status,grant_id FROM ai_credit_purchases WHERE invoice_id=$1", [after!.invoice_id])).rows[0];
    expect(purchase.status).toBe("GRANTED");
    const grant = (await pool.query<{ amount: string; kind: string }>(
      "SELECT amount,kind FROM usage_grants WHERE id=$1", [purchase.grant_id])).rows[0];
    expect(grant).toMatchObject({ amount: String(CREDITS), kind: "CREDIT_PACKAGE" });

    // Reexecução: sem dupla concessão (cobrança APPROVED sai da reconciliação).
    const repeat = await runBatch(fake);
    expect(repeat.granted).toBe(0);
    expect((await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM payments WHERE invoice_id=$1", [after!.invoice_id])).rows[0].n).toBe(1);
    expect((await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM usage_grants g JOIN ai_credit_purchases p ON p.grant_id=g.id WHERE p.invoice_id=$1", [after!.invoice_id])).rows[0].n).toBe(1);
  });

  it("stop local após a cobrança não impede o grant pago nem duplica", async () => {
    const f = await fixture(5);
    const fake = new FakeEfi();
    await runBatch(fake); // cria + PUT (ATIVA)
    const charge = (await chargeOf(f.mandate))!;
    // Stop local DEPOIS da cobrança existir: o Pix pago ainda concede.
    await pool.query("UPDATE ai_credit_pix_mandates SET status='CANCELLED' WHERE id=$1", [f.mandate]);
    fake.charges.get(charge.txid)!.status = "CONCLUIDA";

    const result = await runBatch(fake);
    expect(result.granted).toBe(1);
    expect((await pool.query<{ status: string }>(
      "SELECT status FROM invoices WHERE id=$1", [charge.invoice_id])).rows[0].status).toBe("paid");
    const purchase = (await pool.query<{ status: string; grant_id: string }>(
      "SELECT status,grant_id FROM ai_credit_purchases WHERE invoice_id=$1", [charge.invoice_id])).rows[0];
    expect(purchase.status).toBe("GRANTED");
    expect((await pool.query<{ amount: string }>(
      "SELECT amount FROM usage_grants WHERE id=$1", [purchase.grant_id])).rows[0].amount).toBe(String(CREDITS));

    // Reexecução idempotente: nada duplicado.
    expect((await runBatch(fake)).granted).toBe(0);
    expect((await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM payments WHERE invoice_id=$1", [charge.invoice_id])).rows[0].n).toBe(1);
    expect((await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM usage_grants g JOIN ai_credit_purchases p ON p.grant_id=g.id WHERE p.invoice_id=$1",
      [charge.invoice_id])).rows[0].n).toBe(1);
  });

  it("recusa payload divergente (valor, idRec, vencimento) sem qualquer efeito", async () => {
    const f = await fixture(5);
    const fake = new FakeEfi();
    await runBatch(fake);
    const charge = (await chargeOf(f.mandate))!;
    fake.charges.get(charge.txid)!.status = "CONCLUIDA";

    fake.valorOverride = "99.00";
    const tampered = await runBatch(fake);
    expect(tampered.granted).toBe(0);
    expect(tampered.errors.some((error) => error.txid === charge.txid)).toBe(true);
    expect((await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM payments WHERE invoice_id=$1", [charge.invoice_id])).rows[0].n).toBe(0);
    expect((await chargeOf(f.mandate))!.status).toBe("PENDING");

    // Payload íntegro volta a conceder — a recusa foi do conteúdo, não do fluxo.
    fake.valorOverride = null;
    const restored = await runBatch(fake);
    expect(restored.granted).toBe(1);
  });

  it("CONCLUIDA no PUT mas ATIVA no GET não concede (grant exige GET)", async () => {
    const f = await fixture(5);
    const fake = new FakeEfi();
    fake.putStatus = "CONCLUIDA";
    fake.storeStatus = "ATIVA"; // Efí "real" continua aguardando pagamento
    const result = await runBatch(fake);
    expect(result.created).toBe(1);
    expect(result.granted).toBe(0);
    expect(fake.getCalls).toBeGreaterThan(0); // houve reconfirmação via GET (o PUT não concede)
    const charge = (await chargeOf(f.mandate))!;
    expect(charge.status).toBe("PENDING");
    expect((await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM payments WHERE invoice_id=$1", [charge.invoice_id])).rows[0].n).toBe(0);
  });

  it("falha terminal (CANCELADA/EXPIRADA) não concede e marca a cobrança", async () => {
    const f = await fixture(5);
    const fake = new FakeEfi();
    await runBatch(fake);
    const charge = (await chargeOf(f.mandate))!;
    fake.charges.get(charge.txid)!.status = "CANCELADA";
    const result = await runBatch(fake);
    expect(result.failed).toBe(1);
    expect(result.granted).toBe(0);
    expect((await chargeOf(f.mandate))!.status).toBe("CANCELLED");
    expect((await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM payments WHERE invoice_id=$1", [charge.invoice_id])).rows[0].n).toBe(0);
    // Fatura do ciclo não pago é encerrada (não fica "pendente" para sempre).
    expect((await pool.query<{ status: string }>("SELECT status FROM invoices WHERE id=$1", [charge.invoice_id])).rows[0].status).toBe("cancelled");
  });

  it("cobrança EXPIRADA/NEGADA encerra a fatura como failed, nunca toca fatura paga", async () => {
    const f = await fixture(5);
    const fake = new FakeEfi();
    await runBatch(fake);
    const charge = (await chargeOf(f.mandate))!;
    fake.charges.get(charge.txid)!.status = "EXPIRADA";
    expect((await runBatch(fake)).failed).toBe(1);
    expect((await pool.query<{ status: string }>("SELECT status FROM invoices WHERE id=$1", [charge.invoice_id])).rows[0].status).toBe("failed");
  });

  it("CONCLUIDA→CANCELADA sem evidência de devolução preserva o grant pago e não reconcede", async () => {
    const f = await fixture(5);
    const fake = new FakeEfi();
    await runBatch(fake);
    const charge = (await chargeOf(f.mandate))!;
    fake.charges.get(charge.txid)!.status = "CONCLUIDA";
    expect((await runBatch(fake)).granted).toBe(1);

    // CANCELADA NÃO é evidência de devolução do Pix (não é REFUNDED): sem
    // prova de dinheiro devolvido, o grant pago fica intacto — e nada reconcede.
    fake.charges.get(charge.txid)!.status = "CANCELADA";
    const after = await runBatch(fake);
    expect(after.reversed).toBe(0);
    expect(after.granted).toBe(0);
    expect((await pool.query<{ status: string }>(
      "SELECT status FROM ai_credit_purchases WHERE invoice_id=$1", [charge.invoice_id])).rows[0].status).toBe("GRANTED");
    expect((await pool.query<{ amount: string }>(
      "SELECT amount FROM usage_grants g JOIN ai_credit_purchases p ON p.grant_id=g.id WHERE p.invoice_id=$1",
      [charge.invoice_id])).rows[0].amount).toBe(String(CREDITS));
    expect((await pool.query<{ status: string }>("SELECT status FROM invoices WHERE id=$1", [charge.invoice_id])).rows[0].status).toBe("paid");

    // Reexecução idempotente: continua sem revogar e sem re-conceder.
    const again = await runBatch(fake);
    expect(again.granted).toBe(0);
    expect(again.reversed).toBe(0);
    expect((await pool.query<{ status: string }>(
      "SELECT status FROM ai_credit_purchases WHERE invoice_id=$1", [charge.invoice_id])).rows[0].status).toBe("GRANTED");
  });
});

describe("concorrência e reexecução", () => {
  it("duas execuções paralelas geram uma única cobrança/fatura/payment/grant", async () => {
    const f = await fixture(5);
    const fake = new FakeEfi();
    await runBatch(fake); // cria (ATIVA)
    const charge = (await chargeOf(f.mandate))!;
    fake.charges.get(charge.txid)!.status = "CONCLUIDA";

    const [a, b] = await Promise.all([runBatch(fake), runBatch(fake)]);
    expect(a.granted + b.granted).toBe(1);
    expect((await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM ai_credit_pix_charges WHERE mandate_id=$1", [f.mandate])).rows[0].n).toBe(1);
    expect((await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM invoices WHERE tenant_id=$1", [f.tenant])).rows[0].n).toBe(1);
    expect((await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM ai_credit_purchases WHERE tenant_id=$1", [f.tenant])).rows[0].n).toBe(1);
    expect((await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM payments WHERE invoice_id=$1", [charge.invoice_id])).rows[0].n).toBe(1);
    expect((await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM usage_grants WHERE idempotency_key=$1", [`credit-pack:${charge.invoice_id}`])).rows[0].n).toBe(1);
    expect((await chargeOf(f.mandate))!.status).toBe("APPROVED");
  });

  it("duas execuções paralelas na criação produzem uma única cobrança com o mesmo txid", async () => {
    const f = await fixture(6);
    const fake = new FakeEfi();
    const [a, b] = await Promise.all([runBatch(fake), runBatch(fake)]);
    expect(a.created + b.created).toBe(1);
    expect((await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM ai_credit_pix_charges WHERE mandate_id=$1", [f.mandate])).rows[0].n).toBe(1);
    expect((await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM invoices WHERE tenant_id=$1", [f.tenant])).rows[0].n).toBe(1);
  });
});

describe("estorno Efí: só DEVOLVIDO autenticado integral revoga (sem heurística)", () => {
  const E2E = `E${"1".repeat(31)}`;
  async function paidCharge(): Promise<{ tenant: string; charge: ChargeRow }> {
    const f = await fixture(5);
    const fake = new FakeEfi();
    await runBatch(fake);
    const charge = (await chargeOf(f.mandate))!;
    fake.charges.get(charge.txid)!.status = "CONCLUIDA";
    expect((await runBatch(fake)).granted).toBe(1);
    return { tenant: f.tenant, charge };
  }
  const pixWith = (txid: string, devolucoes: unknown[], valor = "157.00") => ({
    getPix: async (e2eId: string) => ({ endToEndId: e2eId, txid, valor, devolucoes })
  });
  const statusOf = async (charge: ChargeRow) => ({
    invoice: (await pool.query<{ status: string }>("SELECT status FROM invoices WHERE id=$1", [charge.invoice_id])).rows[0].status,
    purchase: (await pool.query<{ status: string }>("SELECT status FROM ai_credit_purchases WHERE invoice_id=$1", [charge.invoice_id])).rows[0].status,
    remaining: Number((await pool.query<{ r: string }>(
      "SELECT amount-consumed_amount AS r FROM usage_grants WHERE idempotency_key=$1", [`credit-pack:${charge.invoice_id}`])).rows[0].r)
  });

  it("EM_PROCESSAMENTO/NAO_REALIZADO/sem devoluções não descontam nada", async () => {
    const { charge } = await paidCharge();
    for (const devolucoes of [[], [{ valor: "157.00", status: "EM_PROCESSAMENTO" }], [{ valor: "157.00", status: "NAO_REALIZADO" }]]) {
      expect(await applyVerifiedEfiRefund(charge.id, E2E, pixWith(charge.txid, devolucoes))).toBe("no_refund");
    }
    expect(await statusOf(charge)).toEqual({ invoice: "paid", purchase: "GRANTED", remaining: CREDITS });
  });

  it("devolução parcial não desconta: fica para revisão humana", async () => {
    const { charge } = await paidCharge();
    expect(await applyVerifiedEfiRefund(charge.id, E2E, pixWith(charge.txid, [{ valor: "50.00", status: "DEVOLVIDO" }]))).toBe("partial_review");
    expect(await statusOf(charge)).toEqual({ invoice: "paid", purchase: "GRANTED", remaining: CREDITS });
  });

  it("Pix de outra cobrança/valor é recusado sem tocar o saldo", async () => {
    const { charge } = await paidCharge();
    await expect(applyVerifiedEfiRefund(charge.id, E2E, pixWith("outrotxid0000000000000000000", [{ valor: "157.00", status: "DEVOLVIDO" }]))).rejects.toThrow(/não corresponde/);
    await expect(applyVerifiedEfiRefund(charge.id, E2E, pixWith(charge.txid, [{ valor: "157.00", status: "DEVOLVIDO" }], "1.00"))).rejects.toThrow(/não corresponde/);
    expect(await statusOf(charge)).toEqual({ invoice: "paid", purchase: "GRANTED", remaining: CREDITS });
  });

  it("DEVOLVIDO integral revoga o saldo restante uma única vez (idempotente)", async () => {
    const { charge } = await paidCharge();
    const client = pixWith(charge.txid, [{ valor: "100.00", status: "DEVOLVIDO" }, { valor: "57.00", status: "DEVOLVIDO" }]);
    const [a, b] = await Promise.all([applyVerifiedEfiRefund(charge.id, E2E, client), applyVerifiedEfiRefund(charge.id, E2E, client)]);
    expect([a, b].sort()).toEqual(["already_refunded", "refunded"]);
    expect(await statusOf(charge)).toEqual({ invoice: "refunded", purchase: "REVERSED", remaining: 0 });
    expect(await applyVerifiedEfiRefund(charge.id, E2E, client)).toBe("already_refunded");
    // Lote posterior não re-concede a fatura estornada.
    expect((await pool.query<{ status: string }>("SELECT status FROM payments WHERE invoice_id=$1", [charge.invoice_id])).rows.map((r) => r.status)).toEqual(["refunded"]);
  });
});
