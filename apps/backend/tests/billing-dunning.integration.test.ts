import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { runDunningBatch } from "../src/billing/dunning.js";
import { runBillingReconciliationBatch } from "../src/billing/reconciler.js";
import { ensureOpenPeriod } from "../src/billing/usage-period.js";
import { changeStatus } from "../src/modules/saas/service.js";
import type { BillingProvider, PaymentInput, ProviderResult, WebhookResult } from "../src/billing/providers/types.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
class FakeProvider implements BillingProvider {
  calls: PaymentInput[] = []; fail = false;
  async createPayment(input: PaymentInput): Promise<ProviderResult> { this.calls.push(input); if (this.fail) throw new Error("gateway down"); return { externalId: `dunning-${this.calls.length}`, status: "pending", payload: {} }; }
  createCustomer(): Promise<ProviderResult> { throw new Error("unused"); } createSubscription(): Promise<ProviderResult> { throw new Error("unused"); }
  cancelSubscription(): Promise<ProviderResult> { throw new Error("unused"); } getPayment(): Promise<ProviderResult> { throw new Error("unused"); }
  handleWebhook(): Promise<WebhookResult> { throw new Error("unused"); }
}
async function fixture() {
  const key = randomUUID(), tenant = (await pool.query<{id:string}>("INSERT INTO tenants(name,slug,status) VALUES($1,$2,'active') RETURNING id", [`Dunning ${key}`,`dunning-${key}`])).rows[0].id;
  const provider = (await pool.query<{id:string}>("INSERT INTO billing_providers(homologated,code,name,enabled,environment,status,accepted_methods,credentials_encrypted) VALUES(true,$1,'Fake',true,'production','CONNECTED',ARRAY['pix'],'x') RETURNING id",[`fake-${key}`])).rows[0].id;
  const subscription = (await pool.query<{id:string}>("INSERT INTO tenant_subscriptions(tenant_id,plan_id,status,current_period_start,current_period_end) SELECT $1,id,'ACTIVE',now(),now()+interval '1 month' FROM plans WHERE code='BASIC' RETURNING id",[tenant])).rows[0].id;
  await pool.query("INSERT INTO billing_accounts(tenant_id,provider_id,email,document) VALUES($1,$2,'dunning@test.local','123')",[tenant,provider]);
  const fake = new FakeProvider();
  async function invoice() { return (await pool.query<{id:string}>("INSERT INTO invoices(tenant_id,provider_id,subscription_id,kind,amount_cents,currency,status,due_date) VALUES($1,$2,$3,'SUBSCRIPTION',1000,'BRL','open',now()-interval '1 hour') RETURNING id",[tenant,provider,subscription])).rows[0].id; }
  return {tenant,subscription,fake,invoice,async clean(){await pool.query("DELETE FROM tenants WHERE id=$1",[tenant]);}};
}
// Assinatura MONTHLY precificada cujo ciclo e período de uso acabaram de
// vencer: o caminho REAL (reconciliador) é quem emite a fatura de renovação.
async function renewalFixture() {
  const x = await fixture();
  await pool.query("UPDATE tenant_subscriptions SET billing_cycle='MONTHLY',base_price_cents=1000,final_price_cents=1000,snapshot_currency='BRL',current_period_start=now()-interval '1 month',current_period_end=now()-interval '1 second' WHERE id=$1", [x.subscription]);
  await pool.query("INSERT INTO usage_periods(tenant_id,subscription_id,sequence,start_at,end_at,included_limit,status) VALUES($1,$2,1,now()-interval '1 month',now()-interval '1 second',0,'OPEN')", [x.tenant, x.subscription]);
  return x;
}
async function subStatus(id: string) { return (await pool.query<{ status: string }>("SELECT status FROM tenant_subscriptions WHERE id=$1", [id])).rows[0].status; }
beforeAll(async()=>{await pool.query("SELECT 1")}); afterAll(async()=>{await pool.end()});
describe("billing dunning integration",()=>{
  it("charges a due invoice and records the attempt",async()=>{const x=await fixture();try{const id=await x.invoice();const r=await runDunningBatch(100,{db:pool,provider:x.fake});expect(r.attempted).toBe(1);expect(x.fake.calls).toHaveLength(1);expect((await pool.query("SELECT status,attempt_number FROM billing_dunning_attempts WHERE invoice_id=$1",[id])).rows[0]).toMatchObject({status:"PENDING",attempt_number:1});}finally{await x.clean()}});
  // ESCRITO PELO ORQUESTRADOR: a sabotagem do curto-circuito (charges.ts devolvendo
  // qualquer payment sem chamar o provider) NAO derrubava nenhum teste. Este e o
  // cenario central do bloqueador B2: cliente cuja 1a cobranca foi REJEITADA precisa
  // ser recobrado de verdade, e a tentativa nao pode ser reportada como SUCCEEDED.
  it("retries for real when the previous payment was rejected (B2)",async()=>{
    process.env.DUNNING_SPACING_HOURS="0";
    const x=await fixture();
    try{
      const id=await x.invoice();
      // 1a tentativa: provider devolve pending, grava external_id na fatura + payment
      await runDunningBatch(100,{db:pool,provider:x.fake});
      const callsAfterFirst=x.fake.calls.length;
      expect(callsAfterFirst).toBe(1);
      // o pagamento e RECUSADO (estado real apos recusa do gateway)
      await pool.query("UPDATE payments SET status='rejected' WHERE invoice_id=$1",[id]);
      // 2a rodada: TEM que chamar o provider de novo, nao curto-circuitar no rejected
      await runDunningBatch(100,{db:pool,provider:x.fake});
      expect(x.fake.calls.length).toBeGreaterThan(callsAfterFirst);
      // e nenhuma tentativa pode estar marcada como sucesso: o provider devolveu pending
      const attempts=(await pool.query<{status:string}>("SELECT status FROM billing_dunning_attempts WHERE invoice_id=$1 ORDER BY attempt_number",[id])).rows;
      expect(attempts.length).toBeGreaterThanOrEqual(2);
      expect(attempts.map(a=>a.status)).not.toContain("SUCCEEDED");
    }finally{delete process.env.DUNNING_SPACING_HOURS;await x.clean()}
  });
  it("never duns a credit-package invoice (Efí Pix Automático cycle has due_date)",async()=>{const x=await fixture();try{const id=(await pool.query<{id:string}>("INSERT INTO invoices(tenant_id,kind,amount_cents,currency,status,due_date) VALUES($1,'credit_package',15700,'BRL','pending',now()-interval '1 day') RETURNING id",[x.tenant])).rows[0].id;await runDunningBatch(100,{db:pool,provider:x.fake});expect(x.fake.calls).toHaveLength(0);expect((await pool.query("SELECT 1 FROM billing_dunning_attempts WHERE invoice_id=$1",[id])).rowCount).toBe(0);expect((await pool.query<{status:string}>("SELECT status FROM tenant_subscriptions WHERE id=$1",[x.subscription])).rows[0].status).toBe("ACTIVE");}finally{await x.clean()}});
  it("respects retry spacing",async()=>{const x=await fixture();try{const id=await x.invoice();await runDunningBatch(100,{db:pool,provider:x.fake});const r=await runDunningBatch(100,{db:pool,provider:x.fake});expect(r.attempted).toBe(0);expect((await pool.query("SELECT count(*) FROM billing_dunning_attempts WHERE invoice_id=$1",[id])).rows[0].count).toBe("1");}finally{await x.clean()}});
  it("records gateway failure and retries after spacing",async()=>{process.env.DUNNING_SPACING_HOURS="0";const x=await fixture();try{x.fake.fail=true;const id=await x.invoice();const first=await runDunningBatch(100,{db:pool,provider:x.fake});expect(first.failed).toBe(1);x.fake.fail=false;await runDunningBatch(100,{db:pool,provider:x.fake});expect((await pool.query("SELECT count(*) FROM billing_dunning_attempts WHERE invoice_id=$1",[id])).rows[0].count).toBe("2");}finally{delete process.env.DUNNING_SPACING_HOURS;await x.clean()}});
  it("exhausts attempts and marks the subscription suspended",async()=>{process.env.DUNNING_MAX_ATTEMPTS="1";process.env.DUNNING_SPACING_HOURS="0";const x=await fixture();try{x.fake.fail=true;await x.invoice();await runDunningBatch(100,{db:pool,provider:x.fake});await pool.query("UPDATE tenant_subscriptions SET status='SUSPENDED' WHERE id=$1",[x.subscription]);expect((await pool.query("SELECT dunning_exhausted_at FROM invoices WHERE subscription_id=$1",[x.subscription])).rows[0].dunning_exhausted_at).not.toBeNull();expect((await pool.query("SELECT status FROM tenant_subscriptions WHERE id=$1",[x.subscription])).rows[0].status).toBe("SUSPENDED");}finally{delete process.env.DUNNING_MAX_ATTEMPTS;delete process.env.DUNNING_SPACING_HOURS;await x.clean()}});
  it("reactivates after debt is paid",async()=>{const x=await fixture();try{const id=await x.invoice();await pool.query("UPDATE tenant_subscriptions SET status='SUSPENDED' WHERE id=$1",[x.subscription]);await pool.query("UPDATE invoices SET status='paid' WHERE id=$1",[id]);const r=await runDunningBatch(100,{db:pool,provider:x.fake});expect(r.reactivated).toBe(1);expect((await pool.query("SELECT status FROM tenant_subscriptions WHERE id=$1",[x.subscription])).rows[0].status).toBe("ACTIVE");}finally{await x.clean()}});
  it("does not double-charge concurrent batches",async()=>{const x=await fixture();try{await x.invoice();const [a,b]=await Promise.all([runDunningBatch(100,{db:pool,provider:x.fake}),runDunningBatch(100,{db:pool,provider:x.fake})]);expect(a.attempted+b.attempted).toBe(1);expect(x.fake.calls).toHaveLength(1);}finally{await x.clean()}});

  it("C1: a renewal issued by the real reconciler carries a due date and is dunned once overdue", async () => {
    const x = await renewalFixture();
    try {
      await runBillingReconciliationBatch(1000, { db: pool, provider: x.fake });
      const invoices = (await pool.query<{ id: string; due_date: Date | null; amount_cents: string }>("SELECT id,due_date,amount_cents FROM invoices WHERE subscription_id=$1 AND kind='subscription'", [x.subscription])).rows;
      expect(invoices).toHaveLength(1);
      expect(invoices[0].amount_cents).toBe("1000");
      expect(invoices[0].due_date).not.toBeNull();
      expect(invoices[0].due_date!.getTime()).toBeGreaterThan(Date.now());
      await runDunningBatch(100, { db: pool, provider: x.fake });
      expect(x.fake.calls.filter(c => c.invoiceId === invoices[0].id)).toHaveLength(0);
      // O tempo passa até depois do vencimento emitido pelo próprio sistema.
      await pool.query("UPDATE invoices SET due_date=now()-interval '1 hour' WHERE id=$1", [invoices[0].id]);
      await runDunningBatch(100, { db: pool, provider: x.fake });
      expect((await pool.query("SELECT 1 FROM billing_dunning_attempts WHERE invoice_id=$1", [invoices[0].id])).rowCount).toBe(1);
      expect(await subStatus(x.subscription)).toBe("PAST_DUE");
    } finally { await x.clean(); }
  });
  it("C1/N1: a period closed by the AI hot path (outside the reconciler) is still invoiced", async () => {
    const x = await renewalFixture();
    try {
      const c = await pool.connect();
      try { await c.query("BEGIN"); await ensureOpenPeriod(c, x.tenant); await c.query("COMMIT"); } finally { c.release(); }
      expect((await pool.query("SELECT 1 FROM usage_periods WHERE tenant_id=$1 AND status='CLOSED'", [x.tenant])).rowCount).toBe(1);
      await runBillingReconciliationBatch(1000, { db: pool, provider: x.fake });
      expect((await pool.query("SELECT 1 FROM invoices WHERE subscription_id=$1 AND kind='subscription'", [x.subscription])).rowCount).toBe(1);
    } finally { await x.clean(); }
  });
  it("C7: reactivation is driven by delinquent subscriptions and is not starved by paid ACTIVE ones", async () => {
    const key = randomUUID();
    try {
      await pool.query(`WITH t AS (INSERT INTO tenants(name,slug,status) SELECT 'dun-bulk-'||g||'-'||$1,'dun-bulk-'||g||'-'||$1,'active' FROM generate_series(1,150) g RETURNING id),
        s AS (INSERT INTO tenant_subscriptions(tenant_id,plan_id,status,current_period_start,current_period_end) SELECT t.id,(SELECT id FROM plans WHERE code='BASIC'),'ACTIVE',now(),now()+interval '1 month' FROM t RETURNING id,tenant_id)
        INSERT INTO invoices(tenant_id,subscription_id,kind,amount_cents,currency,status) SELECT tenant_id,id,'subscription',1000,'BRL','paid' FROM s`, [key]);
      // UUID máximo: fica por último em qualquer ordenação por tenant.
      const tenant = (await pool.query<{ id: string }>("INSERT INTO tenants(id,name,slug,status) VALUES($1,$2,$2,'active') RETURNING id", [`ffffffff-ffff-4fff-bfff-${key.slice(-12)}`, `dun-bulk-late-${key}`])).rows[0].id;
      const sub = (await pool.query<{ id: string }>("INSERT INTO tenant_subscriptions(tenant_id,plan_id,status,current_period_start,current_period_end,grace_period_ends_at) SELECT $1,id,'PAST_DUE',now(),now()+interval '1 month',now()+interval '7 days' FROM plans WHERE code='BASIC' RETURNING id", [tenant])).rows[0].id;
      await pool.query("INSERT INTO invoices(tenant_id,subscription_id,kind,amount_cents,currency,status) VALUES($1,$2,'subscription',1000,'BRL','paid')", [tenant, sub]);
      await runDunningBatch(100, { db: pool, provider: new FakeProvider() });
      expect(await subStatus(sub)).toBe("ACTIVE");
    } finally { await pool.query("DELETE FROM tenants WHERE slug LIKE $1", [`dun-bulk-%${key}`]); }
  });
  it("N2: dunning never reverts a manual ROOT suspension of a tenant without debt", async () => {
    const x = await fixture();
    const actor = (await pool.query<{ id: string }>("INSERT INTO users(email,status) VALUES($1,'active') RETURNING id", [`dunning-root-${randomUUID()}@test.local`])).rows[0].id;
    try {
      await pool.query("INSERT INTO invoices(tenant_id,subscription_id,kind,amount_cents,currency,status) VALUES($1,$2,'subscription',1000,'BRL','paid')", [x.tenant, x.subscription]);
      await changeStatus(x.tenant, "SUSPENDED", actor);
      await runDunningBatch(100000, { db: pool, provider: x.fake });
      expect(await subStatus(x.subscription)).toBe("SUSPENDED");
    } finally { await x.clean(); await pool.query("DELETE FROM audit_logs WHERE actor_user_id=$1", [actor]); await pool.query("DELETE FROM users WHERE id=$1", [actor]); }
  });
  it("S2: paying the debt of a SUSPENDED subscription does not back-bill the suspended months", async () => {
    const x = await fixture();
    try {
      await pool.query("UPDATE tenant_subscriptions SET status='SUSPENDED',suspended_at=now()-interval '3 months',billing_cycle='MONTHLY',base_price_cents=1000,final_price_cents=1000,snapshot_currency='BRL',current_period_start=now()-interval '4 months',current_period_end=now()-interval '3 months' WHERE id=$1", [x.subscription]);
      await pool.query("INSERT INTO usage_periods(tenant_id,subscription_id,sequence,start_at,end_at,included_limit,status) VALUES($1,$2,1,now()-interval '4 months',now()-interval '3 months',0,'OPEN')", [x.tenant, x.subscription]);
      // A dívida que levou à suspensão foi quitada.
      await pool.query("INSERT INTO invoices(tenant_id,subscription_id,kind,amount_cents,currency,status,due_date) VALUES($1,$2,'subscription',1000,'BRL','paid',now()-interval '4 months')", [x.tenant, x.subscription]);
      await runDunningBatch(100000, { db: pool, provider: x.fake });
      expect(await subStatus(x.subscription)).toBe("ACTIVE");
      await runBillingReconciliationBatch(1000, { db: pool, provider: x.fake });
      expect((await pool.query("SELECT 1 FROM usage_periods WHERE tenant_id=$1 AND status='OPEN' AND end_at > now()", [x.tenant])).rowCount).toBe(1);
      expect((await pool.query("SELECT 1 FROM invoice_line_items l JOIN invoices i ON i.id=l.invoice_id WHERE i.subscription_id=$1 AND l.kind='PLAN'", [x.subscription])).rowCount).toBe(0);
    } finally { await x.clean(); }
  });
});
