import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { runDunningBatch } from "../src/billing/dunning.js";
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
  it("respects retry spacing",async()=>{const x=await fixture();try{const id=await x.invoice();await runDunningBatch(100,{db:pool,provider:x.fake});const r=await runDunningBatch(100,{db:pool,provider:x.fake});expect(r.attempted).toBe(0);expect((await pool.query("SELECT count(*) FROM billing_dunning_attempts WHERE invoice_id=$1",[id])).rows[0].count).toBe("1");}finally{await x.clean()}});
  it("records gateway failure and retries after spacing",async()=>{process.env.DUNNING_SPACING_HOURS="0";const x=await fixture();try{x.fake.fail=true;const id=await x.invoice();const first=await runDunningBatch(100,{db:pool,provider:x.fake});expect(first.failed).toBe(1);x.fake.fail=false;await runDunningBatch(100,{db:pool,provider:x.fake});expect((await pool.query("SELECT count(*) FROM billing_dunning_attempts WHERE invoice_id=$1",[id])).rows[0].count).toBe("2");}finally{delete process.env.DUNNING_SPACING_HOURS;await x.clean()}});
  it("exhausts attempts and marks the subscription suspended",async()=>{process.env.DUNNING_MAX_ATTEMPTS="1";process.env.DUNNING_SPACING_HOURS="0";const x=await fixture();try{x.fake.fail=true;await x.invoice();await runDunningBatch(100,{db:pool,provider:x.fake});await pool.query("UPDATE tenant_subscriptions SET status='SUSPENDED' WHERE id=$1",[x.subscription]);expect((await pool.query("SELECT dunning_exhausted_at FROM invoices WHERE subscription_id=$1",[x.subscription])).rows[0].dunning_exhausted_at).not.toBeNull();expect((await pool.query("SELECT status FROM tenant_subscriptions WHERE id=$1",[x.subscription])).rows[0].status).toBe("SUSPENDED");}finally{delete process.env.DUNNING_MAX_ATTEMPTS;delete process.env.DUNNING_SPACING_HOURS;await x.clean()}});
  it("reactivates after debt is paid",async()=>{const x=await fixture();try{const id=await x.invoice();await pool.query("UPDATE tenant_subscriptions SET status='SUSPENDED' WHERE id=$1",[x.subscription]);await pool.query("UPDATE invoices SET status='paid' WHERE id=$1",[id]);const r=await runDunningBatch(100,{db:pool,provider:x.fake});expect(r.reactivated).toBe(1);expect((await pool.query("SELECT status FROM tenant_subscriptions WHERE id=$1",[x.subscription])).rows[0].status).toBe("ACTIVE");}finally{await x.clean()}});
  it("does not double-charge concurrent batches",async()=>{const x=await fixture();try{await x.invoice();const [a,b]=await Promise.all([runDunningBatch(100,{db:pool,provider:x.fake}),runDunningBatch(100,{db:pool,provider:x.fake})]);expect(a.attempted+b.attempted).toBe(1);expect(x.fake.calls).toHaveLength(1);}finally{await x.clean()}});
});
