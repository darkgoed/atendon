import { db } from "../db/client.js";
import { withTenantTransaction } from "../db/tenant-transaction.js";
import { AI_CREDIT_PACK_PRICE_CENTS, revokeCreditPackageGrant } from "./credit-packs.js";
import type { EfiPixAutomaticClient } from "./providers/efipay-pix-automatic.js";

/**
 * Estorno do pacote mensal Efí — SÓ com evidência documentada e autenticada.
 *
 * Única prova aceita: GET /v2/pix/:e2eId (docs Efí "Gestão de Pix") do Pix que
 * liquidou ESTA cobrança (txid e valor conferem) com `devolucoes[]` cujo total
 * em status DEVOLVIDO cobre o valor pago. CANCELADA/NEGADA/EXPIRADA da cobrança,
 * EM_PROCESSAMENTO e NAO_REALIZADO nunca estornam. Devolução parcial não
 * desconta nada (sem heurística): volta "partial_review" para decisão humana.
 *
 * NÃO LIGADO a job/webhook: a Efí não documenta como obter o e2eId do Pix que
 * pagou uma cobrança de Pix Automático (o exemplo de `tentativas[].endToEndId`
 * só mostra tentativas agendadas/canceladas/expiradas) nem o payload do webhook
 * de devolução recebida para cobr. Ver docs/EFI_PIX_AUTOMATICO_PENDENCIAS.md.
 */
export type EfiRefundOutcome = "refunded" | "already_refunded" | "partial_review" | "no_refund" | "not_paid";
export type EfiRefundClient = Pick<EfiPixAutomaticClient, "getPix">;

type Devolucao = { valor?: unknown; status?: unknown };

function cents(value: unknown): number | null {
  const text = typeof value === "string" ? value : "";
  return /^\d+\.\d{2}$/.test(text) ? Math.round(Number(text) * 100) : null;
}

/** Total devolvido (centavos) com status DEVOLVIDO no payload autenticado. */
export function devolvedCents(pix: Record<string, unknown>): number {
  const list = Array.isArray(pix.devolucoes) ? (pix.devolucoes as Devolucao[]) : [];
  return list.filter((d) => d.status === "DEVOLVIDO").reduce((sum, d) => sum + (cents(d.valor) ?? 0), 0);
}

export async function applyVerifiedEfiRefund(chargeId: string, e2eId: string, client: EfiRefundClient): Promise<EfiRefundOutcome> {
  const charge = (await db.query<{ tenant_id: string; txid: string; invoice_id: string | null }>(
    `SELECT m.tenant_id, c.txid, c.invoice_id FROM ai_credit_pix_charges c
       JOIN ai_credit_pix_mandates m ON m.id=c.mandate_id WHERE c.id=$1`, [chargeId])).rows[0];
  if (!charge?.invoice_id) throw new Error(`cobrança ${chargeId} sem fatura`);

  const pix = await client.getPix(e2eId);
  // O Pix precisa ser o desta cobrança e do valor integral do pacote.
  if (pix.endToEndId !== e2eId || pix.txid !== charge.txid || cents(pix.valor) !== AI_CREDIT_PACK_PRICE_CENTS) {
    throw new Error(`Pix ${e2eId} não corresponde à cobrança ${charge.txid}`);
  }
  const devolved = devolvedCents(pix);
  if (devolved === 0) return "no_refund";
  if (devolved < AI_CREDIT_PACK_PRICE_CENTS) return "partial_review";

  const invoiceId = charge.invoice_id;
  return await withTenantTransaction(db, charge.tenant_id, async (tx) => {
    const inv = (await tx.query<{ status: string }>(
      "SELECT status FROM invoices WHERE id=$1 AND tenant_id=$2 AND kind='credit_package' FOR UPDATE",
      [invoiceId, charge.tenant_id])).rows[0];
    if (!inv) throw new Error(`fatura ${invoiceId} inconsistente`);
    if (inv.status === "refunded") return "already_refunded";
    if (inv.status !== "paid") return "not_paid";
    await tx.query("UPDATE payments SET status='refunded',paid_at=NULL,updated_at=now() WHERE invoice_id=$1 AND status='paid'", [invoiceId]);
    await tx.query("UPDATE invoices SET status='refunded',paid_at=NULL,updated_at=now() WHERE id=$1", [invoiceId]);
    await revokeCreditPackageGrant(tx, charge.tenant_id, invoiceId);
    return "refunded";
  });
}
