import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { db } from "../db/client.js";
import { withTenantTransaction } from "../db/tenant-transaction.js";
import { ensureOpenPeriod } from "./usage-period.js";

/**
 * Compra de pacotes de créditos de IA (tokens normalizados).
 *
 * Um único SKU fixo no servidor: 50.000.000 créditos por R$157,00. Preço e
 * quantidade NUNCA vêm do cliente (o corpo aceita apenas idempotencyKey); a
 * migration trava o par (credits, price_cents) por CHECK. A fatura nasce
 * kind='credit_package' com subscription_id NULL (nunca renova plano) e a
 * concessão do grant só acontece no webhook autenticado/pago — na MESMA
 * transação do billing_events, via grantPaidCreditPackage (PoolClient).
 * Lock order: fatura → período → grant (nunca grant → período), igual à
 * reserva de IA (subscription → period → grant).
 */

export const AI_CREDIT_PACK_SKU = "AI_CREDITS_50M";
export const AI_CREDIT_PACK_CREDITS = 50_000_000;
export const AI_CREDIT_PACK_PRICE_CENTS = 15_700;

export function grantIdempotencyKeyForInvoice(invoiceId: string): string {
  return `credit-pack:${invoiceId}`;
}

type PurchaseRow = {
  id: string; tenant_id: string; idempotency_key: string; sku: string;
  credits: string; price_cents: string; currency: string; invoice_id: string;
  grant_id: string | null; status: string; granted_at: Date | null;
  revoked_credits: string; revoked_at: Date | null; created_at: Date;
};

export type CreatedPurchase = {
  purchase: { id: string; sku: string; credits: number; priceCents: number; currency: string; status: string; invoiceId: string; createdAt: Date };
  invoice: { id: string; status: string; amountCents: number; currency: string };
};

function toPurchase(row: PurchaseRow, invoiceStatus: string): CreatedPurchase {
  return {
    purchase: { id: row.id, sku: row.sku, credits: Number(row.credits), priceCents: Number(row.price_cents), currency: row.currency, status: row.status, invoiceId: row.invoice_id, createdAt: row.created_at },
    invoice: { id: row.invoice_id, status: invoiceStatus, amountCents: Number(row.price_cents), currency: row.currency }
  };
}

const PURCHASE_WITH_INVOICE = `
  SELECT p.*, i.status AS invoice_status
    FROM ai_credit_purchases p JOIN invoices i ON i.id = p.invoice_id`;

/**
 * Cria (ou reapresenta, por idempotência) a compra: fatura credit_package +
 * linha ADDON + registro em ai_credit_purchases. NADA é concedido aqui.
 */
export async function createCreditPackPurchase(tenantId: string, idempotencyKey: string): Promise<CreatedPurchase> {
  return withTenantTransaction(db, tenantId, async (client) => {
    // Serializa compras por tenant: a re-checagem abaixo é autoritativa sob
    // concorrência (a UNIQUE(tenant_id,idempotency_key) é a segunda linha de defesa).
    await client.query("SELECT pg_advisory_xact_lock(hashtext('ai-credit-pack:' || $1))", [tenantId]);
    const existing = await client.query<PurchaseRow & { invoice_status: string }>(
      `${PURCHASE_WITH_INVOICE} WHERE p.tenant_id=$1 AND p.idempotency_key=$2`, [tenantId, idempotencyKey]);
    if (existing.rows[0]) return toPurchase(existing.rows[0], existing.rows[0].invoice_status);

    const invoiceId = randomUUID();
    const invoice = await client.query<{ id: string }>(
      `INSERT INTO invoices(id,tenant_id,kind,amount_cents,currency,status,metadata)
       VALUES($1,$2,'credit_package',$3,'BRL','pending',$4) RETURNING id`,
      [invoiceId, tenantId, AI_CREDIT_PACK_PRICE_CENTS, JSON.stringify({ reference: `ai-credit-pack:${invoiceId}`, sku: AI_CREDIT_PACK_SKU, credits: AI_CREDIT_PACK_CREDITS })]);
    await client.query(
      `INSERT INTO invoice_line_items(invoice_id,kind,description,quantity,unit_amount_cents,amount_cents,metadata)
       VALUES($1,'ADDON',$2,1,$3,$3,$4)`,
      [invoice.rows[0].id, `Pacote de créditos de IA (${AI_CREDIT_PACK_CREDITS.toLocaleString("pt-BR")} normalizados)`, AI_CREDIT_PACK_PRICE_CENTS, JSON.stringify({ sku: AI_CREDIT_PACK_SKU, credits: AI_CREDIT_PACK_CREDITS })]);
    const purchase = await client.query<PurchaseRow>(
      `INSERT INTO ai_credit_purchases(tenant_id,idempotency_key,sku,credits,price_cents,currency,invoice_id)
       VALUES($1,$2,$3,$4,$5,'BRL',$6) RETURNING *`,
      [tenantId, idempotencyKey, AI_CREDIT_PACK_SKU, AI_CREDIT_PACK_CREDITS, AI_CREDIT_PACK_PRICE_CENTS, invoice.rows[0].id]);
    return toPurchase(purchase.rows[0], "pending");
  });
}

export type GrantOutcome = { grantId: string; periodId: string | null };

/**
 * Concessão idempotente POR FATURA (não por evento): usada pelo webhook dentro
 * da transação do billing_events. Recebe o PoolClient do chamador — NUNCA abre
 * transação própria (wrapper com withTenantTransaction aqui seria não-atômico
 * e morto por deadlock com o webhook). INSERT ... ON CONFLICT DO NOTHING na
 * unique parcial (tenant_id,idempotency_key) + bump de bonus_granted SOMENTE
 * quando o período aberto é da unidade CREDIT e o INSERT inseriu (no replay
 * a grant já está contabilizada — somar de novo duplicaria o saldo). O UPDATE
 * da compra exige status='PENDING_PAYMENT': defesa em profundidade além do
 * guarda dos chamadores — um replay pós-estorno NÃO ressuscita REVERSED
 * (mesma regra de grantAiCreditPackage: em período de interações o pacote
 * fica retido).
 */
export async function grantPaidCreditPackage(client: PoolClient, input: { tenantId: string; invoiceId: string; credits: number }): Promise<GrantOutcome> {
  const idempotencyKey = grantIdempotencyKeyForInvoice(input.invoiceId);
  const period = await ensureOpenPeriod(client, input.tenantId);
  const inserted = await client.query<{ id: string; amount: string }>(
    `INSERT INTO usage_grants(tenant_id,usage_period_id,kind,amount,usage_unit,reason,granted_by_user_id,expires_at,idempotency_key)
     VALUES($1,$2,'CREDIT_PACKAGE',$3,'CREDIT',$4,$5,NULL,$6)
     ON CONFLICT (tenant_id,idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
     RETURNING id, amount`,
    [input.tenantId, period?.id ?? null, Math.ceil(input.credits), `Pacote de créditos de IA (${input.credits} normalizados) — fatura ${input.invoiceId}`, null, idempotencyKey]);
  const grant = inserted.rows[0]
    ?? (await client.query<{ id: string; amount: string }>(
      "SELECT id,amount FROM usage_grants WHERE tenant_id=$1 AND idempotency_key=$2", [input.tenantId, idempotencyKey])).rows[0];
  if (!grant) throw new Error("falha ao conceder pacote de créditos");
  // Bump SOMENTE quando o INSERT inseriu: no replay (ON CONFLICT) a grant já
  // está contabilizada no período — somar de novo duplicaria bonus_granted.
  if (inserted.rows[0] && period && period.usage_unit === "CREDIT") {
    await client.query("UPDATE usage_periods SET bonus_granted=bonus_granted+$2, updated_at=now() WHERE id=$1", [period.id, inserted.rows[0].amount]);
  }
  await client.query(
    `UPDATE ai_credit_purchases SET status='GRANTED', grant_id=$3, granted_at=now(), updated_at=now()
      WHERE invoice_id=$2 AND tenant_id=$1 AND status='PENDING_PAYMENT'`, [input.tenantId, input.invoiceId, grant.id]);
  return { grantId: grant.id, periodId: period?.id ?? null };
}

/**
 * Estorno (refunded/charged_back): revoga APENAS o saldo restante da grant da
 * fatura — consumo parcial permanece histórico; nada é apagado. Idempotente:
 * repetir revoga zero (a compra já REVERSED sai cedo — release/reconcile da
 * reserva pendente pode ter baixado consumed_amount depois do 1º estorno, e um
 * retry sem guarda re-revocaria o remanescente recriado). Tomba a grant
 * (expires_at=agora) na MESMA transação/lock: consumed_amount pode voltar a
 * baixar depois sem ressuscitar saldo gastável. Lock order período → grant (a
 * reserva de IA trava período antes de grant; a ordem inversa aqui é deadlock).
 */
export async function revokeCreditPackageGrant(client: PoolClient, tenantId: string, invoiceId: string): Promise<number> {
  const purchase = await client.query<{ id: string; grant_id: string | null; status: string }>(
    "SELECT id,grant_id,status FROM ai_credit_purchases WHERE invoice_id=$1 AND tenant_id=$2", [invoiceId, tenantId]);
  const row = purchase.rows[0];
  if (!row?.grant_id || row.status === "REVERSED") return 0;
  const grant = await client.query<{ id: string; usage_period_id: string | null; amount: string; consumed_amount: string }>(
    "SELECT id,usage_period_id,amount,consumed_amount FROM usage_grants WHERE id=$1 AND tenant_id=$2", [row.grant_id, tenantId]);
  const g = grant.rows[0];
  if (!g) return 0;
  // Período travado ANTES da grant (mesma ordem do consumo de IA) — nunca o
  // inverso, que cria deadlock com consumeAiInteraction.
  const period = g.usage_period_id
    ? await client.query<{ usage_unit: string }>("SELECT usage_unit FROM usage_periods WHERE id=$1 FOR UPDATE", [g.usage_period_id])
    : null;
  // Trava e relê a grant: o consumed_amount pode ter mudado (reserva de IA
  // concorrente) entre o SELECT acima e o lock do período.
  const locked = await client.query<{ amount: string; consumed_amount: string }>(
    "SELECT amount,consumed_amount FROM usage_grants WHERE id=$1 FOR UPDATE", [g.id]);
  const l = locked.rows[0];
  if (!l) return 0;
  // Tombstone na MESMA transação/lock: consumed_amount pode voltar a BAIXAR
  // depois do commit (release/reconcile da reserva pendente no ai-consumption)
  // e, sem isto, o seletor de IA (aceita grant não-expirada) ressuscitava o
  // saldo após refund/chargeback. A expiração é permanente e independente do
  // contador — vale também com remaining=0. Idempotente: COALESCE preserva o
  // que já existia. Pacote nunca nasce com expiração; REVERSED sai cedo acima.
  // ponytail: leitor iniciado ANTES deste commit pode re-avaliar o seletor com
  // now() velho (recheck pós-lock); consumed==amount no recheck já o exclui —
  // fechar a janela restante exigiria o seletor checar a compra (outro arquivo).
  await client.query("UPDATE usage_grants SET expires_at=COALESCE(expires_at,now()) WHERE id=$1", [g.id]);
  let revoked = 0;
  const remaining = Math.max(0, Number(l.amount) - Number(l.consumed_amount));
  if (remaining > 0) {
    const bumped = await client.query<{ id: string }>(
      "UPDATE usage_grants SET consumed_amount=consumed_amount+$2 WHERE id=$1 AND consumed_amount+$2<=amount RETURNING id", [g.id, remaining]);
    revoked = bumped.rowCount === 1 ? remaining : 0;
    if (revoked > 0 && period?.rows[0]?.usage_unit === "CREDIT") {
      await client.query("UPDATE usage_periods SET bonus_granted=GREATEST(0,bonus_granted-$2), updated_at=now() WHERE id=$1", [g.usage_period_id, revoked]);
    }
  }
  await client.query(
    `UPDATE ai_credit_purchases SET status='REVERSED', revoked_credits=revoked_credits+$3, revoked_at=now(), updated_at=now()
      WHERE id=$1 AND tenant_id=$2`, [row.id, tenantId, revoked]);
  return revoked;
}

export type CreditPackBalance = {
  availableCredits: number;
  grantedCredits: number;
  consumedCredits: number;
  grants: Array<{ id: string; amount: number; consumedAmount: number; remaining: number; active: boolean; expiresAt: Date | null; createdAt: Date; invoiceId: string | null; purchaseStatus: string | null }>;
};

/** Saldo do tenant a partir dos usage_grants ativos (unidade CREDIT). */
export async function creditPackBalance(tenantId: string): Promise<CreditPackBalance> {
  const result = await db.query<{
    id: string; amount: string; consumed_amount: string; expires_at: Date | null; created_at: Date;
    invoice_id: string | null; purchase_status: string | null; active: boolean;
  }>(
    `SELECT g.id,g.amount,g.consumed_amount,g.expires_at,g.created_at,
            (g.expires_at IS NULL OR g.expires_at > now()) AS active,
            p.invoice_id, p.status AS purchase_status
       FROM usage_grants g
       LEFT JOIN ai_credit_purchases p ON p.grant_id = g.id
      WHERE g.tenant_id=$1 AND g.kind='CREDIT_PACKAGE' AND g.usage_unit='CREDIT'
      ORDER BY g.created_at DESC, g.id DESC`, [tenantId]);
  const grants = result.rows.map(row => ({
    id: row.id,
    amount: Number(row.amount),
    consumedAmount: Number(row.consumed_amount),
    remaining: Math.max(0, Number(row.amount) - Number(row.consumed_amount)),
    active: row.active,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    invoiceId: row.invoice_id,
    purchaseStatus: row.purchase_status
  }));
  return {
    availableCredits: grants.filter(g => g.active).reduce((sum, g) => sum + g.remaining, 0),
    grantedCredits: grants.reduce((sum, g) => sum + g.amount, 0),
    consumedCredits: grants.reduce((sum, g) => sum + g.consumedAmount, 0),
    grants
  };
}

export type PurchaseList = { purchases: Array<Record<string, unknown>>; page: number; limit: number };

export async function listCreditPackPurchases(tenantId: string, page: number, limit: number): Promise<PurchaseList> {
  const result = await db.query(
    `${PURCHASE_WITH_INVOICE} WHERE p.tenant_id=$1 ORDER BY p.created_at DESC, p.id DESC LIMIT $2 OFFSET $3`,
    [tenantId, limit, (page - 1) * limit]);
  return { purchases: result.rows, page, limit };
}
