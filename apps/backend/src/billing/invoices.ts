import type { Pool, PoolClient } from "pg";
import { db } from "../db/client.js";
import { withTenantTransaction } from "../db/tenant-transaction.js";
import { applyScheduledChange } from "./proration.js";

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

  // O ciclo CONTRATADO (current_period_*) decide a renovação — não a sequência
  // vitalícia dos períodos de uso. Comparação no banco (precisão de µs);
  // ponytail: tolerância de 1 min absorve o truncamento de ms dos períodos.
  const sub = await client.query<{
    id: string; billing_cycle: string; base_price_cents: string | null;
    final_price_cents: string | null; snapshot_currency: string; plan_id: string;
    renewal_due: boolean; prepaid: boolean;
  }>(`SELECT s.id,s.billing_cycle,s.base_price_cents,s.final_price_cents,s.snapshot_currency,s.plan_id,
         (s.current_period_end IS NULL OR p.end_at + interval '1 minute' >= s.current_period_end) AS renewal_due,
         EXISTS (SELECT 1 FROM invoices i WHERE i.subscription_id=s.id AND i.kind='subscription'
                   AND i.status NOT IN ('cancelled','failed') AND (i.metadata->>'cycle_end')::timestamptz = s.current_period_end) AS prepaid
      FROM tenant_subscriptions s JOIN usage_periods p ON p.id=$3
     WHERE s.id=$1 AND s.tenant_id=$2 FOR UPDATE OF s`, [p.subscription_id, tenantId, periodId]);
  const s = sub.rows[0];
  if (!s) throw error("Assinatura não encontrada", 404, "SUBSCRIPTION_NOT_FOUND");

  const lines: Array<{ kind: string; description: string; quantity: number; unit: number; amount: number; metadata: object }> = [];
  // Ciclo pago antecipadamente (fatura da conversão do trial) não é cobrado de novo.
  if (s.renewal_due && !s.prepaid) lines.push(...planLines(s));
  const overage = Number(p.overage_amount_brl_cents);
  if (overage > 0) lines.push({ kind: "AI_OVERAGE", description: "Excedente de uso de IA", quantity: 1, unit: overage, amount: overage, metadata: { usage_period_id: periodId } });
  const amount = lines.reduce((sum, line) => sum + line.amount, 0);
  // A fatura registra QUAL ciclo contratado ela cobra (antes de o ciclo avançar).
  const cycle = (await client.query<{ cycle_start: string | null; cycle_end: string | null }>(
    "SELECT to_json(current_period_start)#>>'{}' cycle_start, to_json(current_period_end)#>>'{}' cycle_end FROM tenant_subscriptions WHERE id=$1", [s.id])).rows[0];
  if (s.renewal_due) await advanceContractCycle(client, s.id, periodId);
  await client.query("UPDATE usage_periods SET billing_evaluated_at=now() WHERE id=$1", [periodId]);
  // Período sem nada a cobrar (renovação não vencida em ciclo trimestral/anual e
  // sem excedente) NÃO vira fatura: emitir R$0 polui o histórico do cliente e
  // manda o gateway cobrar valor inválido. Fica CLOSED (avaliado).
  if (amount <= 0) return null;
  // A fatura é de assinatura quando contém uma linha PLAN. O período de uso
  // pode gerar somente excedente, e esse pagamento não deve renovar a assinatura.
  const kind = lines.some(line => line.kind === "PLAN") ? "subscription" : "usage";
  const metadata = { usage_period_id: periodId, reference: `usage-period:${periodId}`, billing_cycle: s.billing_cycle, ...(kind === "subscription" ? cycle : {}) };
  // Todo recebível nasce com vencimento: é ele que coloca a fatura no dunning.
  const invoiceResult = await client.query<Invoice>(
    `INSERT INTO invoices(tenant_id,subscription_id,kind,amount_cents,currency,status,due_date,period_start,period_end,metadata)
     VALUES($1,$2,$10, $3,$4,$5,COALESCE($6::timestamptz, now() + make_interval(days => $11)),$7,$8,$9) RETURNING id,tenant_id,subscription_id,amount_cents,currency,status,kind,period_start,period_end,metadata`,
    [tenantId, s.id, amount, s.snapshot_currency, options.status ?? "pending", options.dueDate ?? null, p.start_at, p.end_at, metadata, kind, invoiceDueDays()]);
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

/** Dias entre a emissão e o vencimento de um recebível (DUNNING só age depois). */
export function invoiceDueDays(): number {
  return Math.max(0, Math.trunc(Number(process.env.INVOICE_DUE_DAYS ?? 5)));
}

type PricedSubscription = { billing_cycle: string; base_price_cents: string | null; final_price_cents: string | null };
/** PLAN pelo preço cheio + DISCOUNT até o preço final: o total é sempre o final contratado. */
function planLines(s: PricedSubscription) {
  const final = Number(s.final_price_cents ?? s.base_price_cents ?? 0);
  const base = Math.max(final, Number(s.base_price_cents ?? final));
  if (final <= 0) return [];
  const lines = [{ kind: "PLAN", description: "Plano contratado", quantity: 1, unit: base, amount: base, metadata: { billing_cycle: s.billing_cycle } }];
  if (base > final) lines.push({ kind: "DISCOUNT", description: "Desconto contratado", quantity: 1, unit: final - base, amount: final - base, metadata: { billing_cycle: s.billing_cycle } });
  return lines;
}

export function cycleMonths(billingCycle: string | null | undefined): number {
  return billingCycle === "YEARLY" ? 12 : billingCycle === "QUARTERLY" ? 3 : 1;
}

/**
 * Virada do ciclo contratado: avança current_period_* para o ciclo que contém
 * o fim do período fechado (ancorado no fim anterior, sem deriva de mês curto)
 * e aplica a mudança agendada (downgrade/troca de ciclo) NESTA virada — depois
 * de o ciclo que terminou ter sido cobrado pelo contrato antigo.
 */
async function advanceContractCycle(client: PoolClient, subscriptionId: string, periodId: string): Promise<void> {
  const scheduled = await client.query<{ scheduled_plan_id: string | null }>("SELECT scheduled_plan_id FROM tenant_subscriptions WHERE id=$1", [subscriptionId]);
  if (scheduled.rows[0]?.scheduled_plan_id) {
    const applied = await applyScheduledChange(client, subscriptionId);
    if (applied) return;
  }
  // Menor k≥1 tal que âncora + k ciclos passe do fim do período fechado.
  await client.query(
    `WITH base AS (
       SELECT s.id, COALESCE(s.current_period_end, p.end_at) AS anchor, p.end_at,
              CASE s.billing_cycle WHEN 'YEARLY' THEN 12 WHEN 'QUARTERLY' THEN 3 ELSE 1 END AS months
         FROM tenant_subscriptions s, usage_periods p
        WHERE s.id=$1 AND p.id=$2
     ), next AS (
       SELECT b.id, b.anchor, b.months,
              (SELECT min(g) FROM generate_series(1, 1200) g
                WHERE b.anchor + make_interval(months => b.months * g) > b.end_at + interval '1 minute') AS n
         FROM base b
     )
     UPDATE tenant_subscriptions s
        SET current_period_start = next.anchor + make_interval(months => next.months * (next.n - 1)),
            current_period_end = next.anchor + make_interval(months => next.months * next.n),
            updated_at = now()
       FROM next
      WHERE s.id = next.id`, [subscriptionId, periodId]);
}

export async function createInvoiceForUsagePeriod(client: Client, tenantId: string, usagePeriodId: string, options: InvoiceOptions = {}): Promise<Invoice | null> {
  if (isPool(client)) return withTenantTransaction(client, tenantId, c => createWithin(c, tenantId, usagePeriodId, options));
  return createWithin(client as PoolClient, tenantId, usagePeriodId, options);
}

export async function getBillingHistory(tenantId: string, limit: number): Promise<Array<Omit<Invoice, "metadata"> & { monthly: boolean; line_items: unknown[]; provider_code: string | null; charge?: undefined }>> {
  const result = await db.query<Invoice & { monthly: boolean; line_items: unknown[]; provider_code: string | null }>(
    `SELECT i.id,i.tenant_id,i.subscription_id,i.amount_cents,i.currency,i.status,i.kind,i.period_start,i.period_end,i.metadata,
       COALESCE((i.metadata->>'billing_cycle')='MONTHLY', false) monthly,
       COALESCE((SELECT json_agg(l ORDER BY l.created_at) FROM invoice_line_items l WHERE l.invoice_id=i.id),'[]'::json) line_items,
       (SELECT json_build_object('id',p.external_id,'status',p.status,'qr_code',p.metadata->'point_of_interaction'->'transaction_data'->>'qr_code','ticket_url',p.metadata->'point_of_interaction'->'transaction_data'->>'ticket_url') FROM payments p WHERE p.invoice_id=i.id AND p.method='pix' ORDER BY p.created_at DESC LIMIT 1) charge,
       bp.code provider_code
       FROM invoices i LEFT JOIN billing_providers bp ON bp.id=i.provider_id
       WHERE i.tenant_id=$1 ORDER BY i.created_at DESC LIMIT $2`, [tenantId, Math.max(0, Math.min(100, Math.trunc(limit)))]);
  // metadata sai do retorno público: contém dados internos da fatura e o
  // painel só consome os campos abaixo. O destructuring descarta a coluna sem
  // criar um binding ocioso (a regra no-unused-vars não ignora rest siblings).
  return result.rows.map(row => {
    const invoice = { ...row } as Partial<Invoice> & { monthly: boolean; line_items: unknown[]; provider_code: string | null };
    delete invoice.metadata;
    return { ...(invoice as Omit<Invoice, "metadata"> & { monthly: boolean; line_items: unknown[]; provider_code: string | null }), charge: undefined };
  });
}
