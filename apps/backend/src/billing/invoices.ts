import type { Pool, PoolClient } from "pg";
import { db } from "../db/client.js";
import { withTenantTransaction } from "../db/tenant-transaction.js";

type Client = Pick<PoolClient, "query"> | Pick<Pool, "connect" | "query">;
type InvoiceOptions = { dueDate?: Date; status?: string };
type Invoice = {
  id: string; tenant_id: string; subscription_id: string | null; amount_cents: string;
  currency: string; status: string; kind: string; period_start: Date; period_end: Date;
  metadata: Record<string, unknown>;
};

function isPool(value: Client): value is Pick<Pool, "connect" | "query"> {
  return "connect" in value;
}
function error(message: string, statusCode = 409, code?: string) {
  return Object.assign(new Error(message), { statusCode, ...(code ? { code } : {}) });
}

async function createWithin(client: PoolClient, tenantId: string, periodId: string, options: InvoiceOptions): Promise<Invoice | null> {
  // The period is the serialization point: concurrent callers wait here and the
  // second caller observes the already-created invoice in the same transaction.
  const period = await client.query<{
    id: string; tenant_id: string; subscription_id: string | null; status: string;
    start_at: Date; end_at: Date; sequence: number; overage_amount_brl_cents: string;
  }>(`SELECT id,tenant_id,subscription_id,status,start_at,end_at,sequence,overage_amount_brl_cents
      FROM usage_periods WHERE id=$1 FOR UPDATE`, [periodId]);
  const p = period.rows[0];
  if (!p || p.tenant_id !== tenantId) throw error("Período de uso não encontrado", 404, "USAGE_PERIOD_NOT_FOUND");

  const existing = await client.query<Invoice>(
    `SELECT id,tenant_id,subscription_id,amount_cents,currency,status,kind,period_start,period_end,metadata
       FROM invoices WHERE tenant_id=$1 AND metadata->>'usage_period_id'=$2 LIMIT 1`, [tenantId, periodId]);
  if (p.status === "INVOICED") {
    if (existing.rows[0]) return existing.rows[0];
    throw error("Período marcado como faturado sem fatura", 409, "INVOICE_STATE_INVALID");
  }
  if (p.status !== "CLOSED") throw error("Período de uso ainda não está fechado", 409, "USAGE_PERIOD_NOT_CLOSED");
  if (existing.rows[0]) throw error("Fatura já existe para este período", 409, "INVOICE_ALREADY_EXISTS");

  const sub = await client.query<{
    id: string; billing_cycle: string; base_price_cents: string | null;
    final_price_cents: string | null; snapshot_currency: string; plan_id: string;
  }>(`SELECT s.id,s.billing_cycle,s.base_price_cents,s.final_price_cents,s.snapshot_currency,s.plan_id
      FROM tenant_subscriptions s WHERE s.id=$1 AND s.tenant_id=$2 FOR UPDATE`, [p.subscription_id, tenantId]);
  const s = sub.rows[0];
  if (!s) throw error("Assinatura não encontrada", 404, "SUBSCRIPTION_NOT_FOUND");

  const months = s.billing_cycle === "YEARLY" ? 12 : s.billing_cycle === "QUARTERLY" ? 3 : 1;
  const renewalDue = s.billing_cycle === "MONTHLY" || p.sequence % months === 0;
  const lines: Array<{ kind: string; description: string; quantity: number; unit: number; amount: number; metadata: object }> = [];
  if (renewalDue) {
    const base = Number(s.base_price_cents ?? 0);
    const final = Number(s.final_price_cents ?? base);
    if (final > 0) lines.push({ kind: "PLAN", description: "Plano contratado", quantity: 1, unit: final, amount: final, metadata: { billing_cycle: s.billing_cycle } });
    const discount = base - final;
    if (discount > 0) lines.push({ kind: "DISCOUNT", description: "Desconto contratado", quantity: 1, unit: -discount, amount: -discount, metadata: { billing_cycle: s.billing_cycle } });
  }
  const overage = Number(p.overage_amount_brl_cents);
  if (overage > 0) lines.push({ kind: "AI_OVERAGE", description: "Excedente de uso de IA", quantity: 1, unit: overage, amount: overage, metadata: { usage_period_id: periodId } });
  const amount = lines.reduce((sum, line) => sum + line.amount, 0);
  // Período sem nada a cobrar (renovação não vencida em ciclo trimestral/anual e
  // sem excedente) NÃO vira fatura: emitir R$0 polui o histórico do cliente e
  // manda o gateway cobrar valor inválido.
  //
  // O status permanece CLOSED de propósito: marcá-lo INVOICED sem fatura faria a
  // próxima chamada cair em "Período marcado como faturado sem fatura" (acima).
  // CLOSED é reavaliado a cada ciclo e volta a valer assim que houver o que cobrar.
  if (amount <= 0) return null;
  // A fatura é de assinatura quando contém uma linha PLAN. O período de uso
  // pode gerar somente excedente, e esse pagamento não deve renovar a assinatura.
  const kind = lines.some(line => line.kind === "PLAN") ? "subscription" : "usage";
  const metadata = { usage_period_id: periodId, reference: `usage-period:${periodId}`, billing_cycle: s.billing_cycle };
  const invoiceResult = await client.query<Invoice>(
    `INSERT INTO invoices(tenant_id,subscription_id,kind,amount_cents,currency,status,due_date,period_start,period_end,metadata)
     VALUES($1,$2,$10, $3,$4,$5,$6,$7,$8,$9) RETURNING id,tenant_id,subscription_id,amount_cents,currency,status,kind,period_start,period_end,metadata`,
    [tenantId, s.id, amount, s.snapshot_currency, options.status ?? "pending", options.dueDate ?? null, p.start_at, p.end_at, metadata, kind]);
  const invoice = invoiceResult.rows[0];
  for (const line of lines) {
    await client.query(
      `INSERT INTO invoice_line_items(invoice_id,kind,description,quantity,unit_amount_cents,amount_cents,usage_period_id,metadata)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [invoice.id, line.kind, line.description, line.quantity, line.unit, line.amount, line.kind === "AI_OVERAGE" ? periodId : null, line.metadata]);
  }
  const check = await client.query<{ total: string }>("SELECT COALESCE(SUM(amount_cents),0)::bigint total FROM invoice_line_items WHERE invoice_id=$1", [invoice.id]);
  if (Number(check.rows[0].total) !== amount) throw error("Linhas da fatura não fecham com o total", 500, "INVOICE_TOTAL_MISMATCH");
  await client.query("UPDATE usage_periods SET status='INVOICED',invoiced_at=now(),updated_at=now() WHERE id=$1 AND status='CLOSED'", [periodId]);
  return invoice;
}

export async function createInvoiceForUsagePeriod(client: Client, tenantId: string, usagePeriodId: string, options: InvoiceOptions = {}): Promise<Invoice | null> {
  if (isPool(client)) return withTenantTransaction(client, tenantId, c => createWithin(c, tenantId, usagePeriodId, options));
  return createWithin(client as PoolClient, tenantId, usagePeriodId, options);
}

export async function getBillingHistory(tenantId: string, limit: number): Promise<Array<Invoice & { monthly: boolean; line_items: unknown[] }>> {
  const result = await db.query<Invoice & { monthly: boolean; line_items: unknown[] }>(
    `SELECT i.id,i.tenant_id,i.subscription_id,i.amount_cents,i.currency,i.status,i.kind,i.period_start,i.period_end,i.metadata,
       COALESCE((i.metadata->>'billing_cycle')='MONTHLY', false) monthly,
       COALESCE((SELECT json_agg(l ORDER BY l.created_at) FROM invoice_line_items l WHERE l.invoice_id=i.id),'[]'::json) line_items
       FROM invoices i WHERE i.tenant_id=$1 ORDER BY i.created_at DESC LIMIT $2`, [tenantId, Math.max(0, Math.min(100, Math.trunc(limit)))]);
  return result.rows;
}
