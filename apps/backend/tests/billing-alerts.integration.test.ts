import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { invalidateBillingSettingsCache } from "../src/billing/settings.js";
import { ensureWorkspaceDefaultRoles } from "../src/auth/rbac.js";
import { ensureOpenPeriod } from "../src/billing/usage-period.js";
import { evaluateAlerts, getUsageDashboard } from "../src/billing/alerts.js";
import { setEmailProviderForTests } from "../src/mail/index.js";
import type { EmailProvider } from "../src/mail/email-provider.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const tenants: string[] = [], plans: string[] = [];
let originalSettings: { quota: string; credit: string };

async function setup(limit: number | null = 10000) {
  const slug = `alerts-${randomUUID()}`;
  const t = (await pool.query("INSERT INTO tenants(name,slug,status) VALUES($1,$1,'active') RETURNING id", [slug])).rows[0].id;
  tenants.push(t);
  const p = (await pool.query("INSERT INTO plans(code,name,billing_period_months,monthly_price_cents) VALUES($1,$1,1,0) RETURNING id", [slug])).rows[0].id;
  plans.push(p);
  if (limit !== null) await pool.query("INSERT INTO plan_limits(plan_id,limit_key,limit_value) VALUES($1,'MAX_AI_INTERACTIONS',$2)", [p, limit]);
  const rolesClient = await pool.connect();
  try { await ensureWorkspaceDefaultRoles(rolesClient, t); } finally { rolesClient.release(); }
  await pool.query("INSERT INTO tenant_subscriptions(tenant_id,plan_id,status,current_period_start,current_period_end) VALUES($1,$2,'ACTIVE',now(),now()+interval '1 month')", [t,p]);
  const c = await pool.connect();
  try { await c.query("BEGIN"); await ensureOpenPeriod(c,t); await c.query("COMMIT"); }
  catch (e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
  return t;
}
async function setUsage(t: string, usage: number) { await pool.query("UPDATE usage_periods SET included_usage=$2 WHERE tenant_id=$1 AND status='OPEN'", [t, usage]); }
async function setCreditUsage(t: string, cents: number) { await pool.query("UPDATE usage_periods SET overage_amount_brl_cents=$2,reserved_cents=0 WHERE tenant_id=$1 AND status='OPEN'", [t, cents]); }
async function evaluate(t: string) { const c=await pool.connect(); try { await c.query("BEGIN"); const x=await evaluateAlerts(c,t); await c.query("COMMIT"); return x; } finally { c.release(); } }
async function dashboard(t: string) { const c=await pool.connect(); try { return await getUsageDashboard(c,t); } finally { c.release(); } }

beforeAll(async () => {
  const row = (await pool.query("SELECT quota_alert_thresholds_bps,credit_alert_thresholds_bps FROM billing_settings WHERE id=true")).rows[0];
  originalSettings = { quota: row.quota_alert_thresholds_bps, credit: row.credit_alert_thresholds_bps };
});
afterEach(async () => {
  await pool.query("UPDATE billing_settings SET quota_alert_thresholds_bps=$1,credit_alert_thresholds_bps=$2 WHERE id=true", [originalSettings.quota, originalSettings.credit]);
  invalidateBillingSettingsCache();
  setEmailProviderForTests(undefined);
});
afterAll(async()=>{ try { await pool.query("UPDATE billing_settings SET quota_alert_thresholds_bps=$1,credit_alert_thresholds_bps=$2 WHERE id=true", [originalSettings.quota, originalSettings.credit]); invalidateBillingSettingsCache(); if(tenants.length) await pool.query("DELETE FROM tenants WHERE id=ANY($1::uuid[])",[tenants]); if(plans.length) await pool.query("DELETE FROM plans WHERE id=ANY($1::uuid[])",[plans]); } finally { await pool.end(); } });

describe("billing alerts",()=>{
  it("proves quota thresholds 80, 90, and 100 individually",async()=>{
    for (const [usage, threshold] of [[8000,8000],[9000,9000],[10000,10000]] as const) {
      await pool.query("UPDATE billing_settings SET quota_alert_thresholds_bps=$1 WHERE id=true", [[threshold]]); invalidateBillingSettingsCache();
      const t=await setup(); await setUsage(t,usage); expect((await evaluate(t)).map(a=>a.thresholdBps)).toEqual([threshold]);
    }
  });
  it("crossing quota 0 to 100 inserts all three exactly once and down/up does not repeat",async()=>{
    const t=await setup(); await setUsage(t,0); expect(await evaluate(t)).toEqual([]);
    await setUsage(t,10000); expect((await evaluate(t)).map(a=>a.thresholdBps)).toEqual([8000,9000,10000]);
    await setUsage(t,7000); expect(await evaluate(t)).toEqual([]); await setUsage(t,10000); expect(await evaluate(t)).toEqual([]);
    expect((await pool.query("SELECT threshold_bps FROM usage_alerts WHERE tenant_id=$1 AND alert_type='QUOTA' ORDER BY threshold_bps",[t])).rows.map(r=>Number(r.threshold_bps))).toEqual([8000,9000,10000]);
  });
  it("UNLIMITED has no percent threshold and dashboard documents null availability",async()=>{
    const t=await setup(null); await pool.query("INSERT INTO tenant_usage_credit_settings(tenant_id,enabled,limit_type,confirmed_unlimited_at) VALUES($1,true,'UNLIMITED',now())",[t]); await setUsage(t,100); expect(await evaluate(t)).toEqual([]);
    const d=await dashboard(t); expect(d).toMatchObject({includedLimit:null,totalAvailable:null,usedPercentBps:0});
  });
  it("proves FIXED credit thresholds 50, 80, and 100 with exact values",async()=>{
    const t=await setup(); await pool.query("INSERT INTO tenant_usage_credit_settings(tenant_id,enabled,limit_type,monthly_spending_limit_cents) VALUES($1,true,'FIXED',2000)",[t]);
    for (const [usage, threshold] of [[1000,5000],[1600,8000],[2000,10000]] as const) { await setCreditUsage(t,usage); expect((await evaluate(t)).map(a=>[a.thresholdBps,a.usedPercentBps])).toEqual([[threshold,threshold]]); }
  });
  it("crossing credit 0 to 100 inserts all three exactly once and down/up does not repeat",async()=>{
    const t=await setup(); await pool.query("INSERT INTO tenant_usage_credit_settings(tenant_id,enabled,limit_type,monthly_spending_limit_cents) VALUES($1,true,'FIXED',2000)",[t]); await setCreditUsage(t,0); expect(await evaluate(t)).toEqual([]);
    await setCreditUsage(t,2000); expect((await evaluate(t)).map(a=>a.thresholdBps)).toEqual([5000,8000,10000]); await setCreditUsage(t,1000); expect(await evaluate(t)).toEqual([]); await setCreditUsage(t,2000); expect(await evaluate(t)).toEqual([]);
    expect((await pool.query("SELECT threshold_bps FROM usage_alerts WHERE tenant_id=$1 AND alert_type='CREDIT' ORDER BY threshold_bps",[t])).rows.map(r=>Number(r.threshold_bps))).toEqual([5000,8000,10000]);
  });
  it("reads configurable credit thresholds after cache invalidation",async()=>{ const t=await setup(); await pool.query("INSERT INTO tenant_usage_credit_settings(tenant_id,enabled,limit_type,monthly_spending_limit_cents) VALUES($1,true,'FIXED',2000)",[t]); await pool.query("UPDATE billing_settings SET credit_alert_thresholds_bps=ARRAY[2500,7500] WHERE id=true"); invalidateBillingSettingsCache(); await setCreditUsage(t,1500); expect((await evaluate(t)).map(a=>a.thresholdBps)).toEqual([2500,7500]); });
  it("emails each OWNER and ADMIN once for new alerts and ignores delivery failures",async()=>{
    const t=await setup();
    const recipients=[`owner-alert-${randomUUID()}@test.local`,`admin-alert-${randomUUID()}@test.local`];
    for (const [email,role] of recipients.map((email,i)=>[email,i===0?"OWNER":"ADMIN"] as const)) {
      const user=(await pool.query("INSERT INTO users(email,status) VALUES($1,'active') RETURNING id",[email])).rows[0].id;
      await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at) SELECT $1,$2,id,'active',now() FROM workspace_roles WHERE workspace_id=$1 AND name=$3",[t,user,role]);
    }
    const sent:{to:string;text:string}[]=[];
    const provider:EmailProvider={isConfigured:true,async send(message){sent.push({to:message.to,text:message.text});}};
    setEmailProviderForTests(provider); await setUsage(t,10000); await evaluate(t); await new Promise(resolve=>setImmediate(resolve));
    expect(sent).toHaveLength(6); expect(sent.map(m=>m.to).sort()).toEqual([...recipients,...recipients,...recipients].sort()); expect(sent[0].text).toContain("/uso");
    await evaluate(t); await new Promise(resolve=>setImmediate(resolve)); expect(sent).toHaveLength(6);
    setEmailProviderForTests({isConfigured:true,async send(){throw new Error("mail down");}}); await expect(evaluate(t)).resolves.toEqual([]);
  });
});
