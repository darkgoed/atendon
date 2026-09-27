import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { createInvoiceForUsagePeriod, getBillingHistory } from "../src/billing/invoices.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const tenants: string[] = [], plans: string[] = [];
// O ciclo contratado da assinatura acompanha o billing_cycle (anual = 12 meses);
// `cycleEnd` permite posicionar o fim do ciclo contratado no teste.
async function fixture(cycle: "YEARLY" | "MONTHLY" = "MONTHLY", sequence = 1, cycleEnd = cycle === "YEARLY" ? "12 months" : "1 month", periodEnd = "1 month") {
  const slug = `invoice-${randomUUID()}`;
  const tenant = (await pool.query<{ id: string }>("INSERT INTO tenants(name,slug,status) VALUES($1,$1,'active') RETURNING id", [slug])).rows[0].id;
  tenants.push(tenant);
  const plan = (await pool.query<{ id: string }>("INSERT INTO plans(code,name,billing_period_months,monthly_price_cents) VALUES($1,$1,1,10000) RETURNING id", [`P-${randomUUID()}`])).rows[0].id;
  plans.push(plan);
  const sub = (await pool.query<{ id: string }>(`INSERT INTO tenant_subscriptions(tenant_id,plan_id,status,current_period_start,current_period_end,billing_cycle,base_price_cents,final_price_cents,snapshot_currency) VALUES($1,$2,'ACTIVE',now(),now()+$4::interval,$3,10000,8000,'BRL') RETURNING id`, [tenant, plan, cycle, cycleEnd])).rows[0].id;
  const period = (await pool.query<{ id: string }>(`INSERT INTO usage_periods(tenant_id,subscription_id,sequence,start_at,end_at,included_limit,included_usage,overage_amount_brl_cents,status) VALUES($1,$2,$3,now()-interval '1 month',now()+$4::interval,100,100,2500,'CLOSED') RETURNING id`, [tenant, sub, sequence, periodEnd])).rows[0].id;
  return { tenant, sub, period };
}
async function scalar<T = string>(sql: string, params: unknown[] = []) { return (await pool.query<{ value: T }>(sql, params)).rows[0]?.value; }
afterAll(async () => { if (tenants.length) await pool.query("DELETE FROM tenants WHERE id=ANY($1::uuid[])", [tenants]); if (plans.length) await pool.query("DELETE FROM plans WHERE id=ANY($1::uuid[])", [plans]); await pool.end(); });

describe("billing invoices integration", () => {
  it("annual month 1 immediately invoices only AI_OVERAGE, despite rollover and bonus", async () => {
    const x = await fixture("YEARLY", 1);
    await pool.query("UPDATE usage_periods SET rollover_granted=500,bonus_granted=500 WHERE id=$1", [x.period]);
    const invoice = await createInvoiceForUsagePeriod(pool, x.tenant, x.period);
    expect(invoice).not.toBeNull();
    const lines = await pool.query("SELECT kind,amount_cents FROM invoice_line_items WHERE invoice_id=$1", [invoice!.id]);
    expect(lines.rows).toHaveLength(1); expect(lines.rows[0]).toMatchObject({ kind: "AI_OVERAGE", amount_cents: "2500" });
    expect(invoice!.amount_cents).toBe("2500");
  });
  it("monthly due renewal discriminates PLAN/DISCOUNT/AI_OVERAGE and line sum", async () => {
    const x = await fixture("MONTHLY"); const invoice = await createInvoiceForUsagePeriod(pool, x.tenant, x.period);
    expect(invoice).not.toBeNull();
    const lines = await pool.query<{ kind: string; amount_cents: string }>("SELECT kind,amount_cents FROM invoice_line_items WHERE invoice_id=$1 ORDER BY kind", [invoice!.id]);
    expect(lines.rows.map(r => r.kind)).toEqual(["AI_OVERAGE", "DISCOUNT", "PLAN"]);
    expect(lines.rows.reduce((n, r) => n + Number(r.amount_cents), 0)).toBe(Number(invoice!.amount_cents));
    // N3: PLAN pelo preço cheio (10000) + DISCOUNT (-2000) = preço final contratado (8000); + excedente 2500.
    // O valor antigo (8500) cobrava o desconto duas vezes (PLAN já pelo final + DISCOUNT de novo).
    expect(lines.rows.find(r => r.kind === "PLAN")!.amount_cents).toBe("10000"); expect(invoice!.amount_cents).toBe("10500");
  });
  it("is idempotent and concurrent calls create one invoice and one overage line", async () => {
    const x = await fixture("YEARLY", 1); const [a, b] = await Promise.all([createInvoiceForUsagePeriod(pool, x.tenant, x.period), createInvoiceForUsagePeriod(pool, x.tenant, x.period)]);
    expect(a!.id).toBe(b!.id); expect(await scalar<number>("SELECT count(*)::int AS value FROM invoices WHERE tenant_id=$1", [x.tenant])).toBe(1); expect(await scalar<number>("SELECT count(*)::int AS value FROM invoice_line_items WHERE invoice_id=$1 AND kind='AI_OVERAGE'", [a!.id])).toBe(1);
  });
  it("rejects wrong tenant and OPEN period without changing DB", async () => {
    const x = await fixture(); const other = await fixture(); await pool.query("UPDATE usage_periods SET status='OPEN' WHERE id=$1", [x.period]);
    const before = await scalar<number>("SELECT count(*)::int AS value FROM invoices WHERE tenant_id=$1", [x.tenant]);
    await expect(createInvoiceForUsagePeriod(pool, other.tenant, x.period)).rejects.toMatchObject({ code: "USAGE_PERIOD_NOT_FOUND" });
    await expect(createInvoiceForUsagePeriod(pool, x.tenant, x.period)).rejects.toMatchObject({ code: "USAGE_PERIOD_NOT_CLOSED" });
    expect(await scalar<number>("SELECT count(*)::int AS value FROM invoices WHERE tenant_id=$1", [x.tenant])).toBe(before);
  });
  it("billing history includes monthly flag, usage lines, and charge", async () => {
    const x = await fixture("MONTHLY"); await createInvoiceForUsagePeriod(pool, x.tenant, x.period); const history = await getBillingHistory(x.tenant, 10);
    expect(history).toHaveLength(1); expect(history[0]).toMatchObject({ monthly: true, amount_cents: "10500" }); expect(history[0].line_items).toHaveLength(3);
  });
  it("N3: a 50% contracted discount is charged at the final price, never zeroed by a double discount", async () => {
    const x = await fixture("MONTHLY");
    await pool.query("UPDATE tenant_subscriptions SET base_price_cents=10000,final_price_cents=5000 WHERE id=$1", [x.sub]);
    await pool.query("UPDATE usage_periods SET overage_amount_brl_cents=0 WHERE id=$1", [x.period]);
    const invoice = await createInvoiceForUsagePeriod(pool, x.tenant, x.period);
    expect(invoice?.amount_cents).toBe("5000");
  });
  it("C6: multi-month renewal is anchored to the contract cycle, not to the lifetime period sequence", async () => {
    // Período 12 da vida do tenant, mas o ciclo anual contratado ainda tem 6 meses pela frente.
    const x = await fixture("YEARLY", 12, "6 months");
    const invoice = await createInvoiceForUsagePeriod(pool, x.tenant, x.period);
    expect(invoice!.amount_cents).toBe("2500");
    expect(await scalar<number>("SELECT count(*)::int AS value FROM invoice_line_items WHERE invoice_id=$1 AND kind='PLAN'", [invoice!.id])).toBe(0);
  });
  it("C5/C6: the period that closes the contract cycle bills the annual fee once and advances the cycle", async () => {
    const x = await fixture("YEARLY", 5, "-1 second", "-1 second");
    const invoice = await createInvoiceForUsagePeriod(pool, x.tenant, x.period);
    expect(invoice!.amount_cents).toBe("10500");
    expect(await scalar<boolean>("SELECT current_period_end > now() + interval '11 months' AS value FROM tenant_subscriptions WHERE id=$1", [x.sub])).toBe(true);
    expect(await scalar<boolean>("SELECT due_date > now() AS value FROM invoices WHERE id=$1", [invoice!.id])).toBe(true);
  });
});
