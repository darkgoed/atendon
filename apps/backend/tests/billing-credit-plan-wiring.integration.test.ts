import { randomUUID } from "node:crypto";
import { hash } from "bcryptjs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { buildApp } from "../src/app.js";
import { contractPlanForTenant } from "../src/billing/contracts.js";
import { getOverLimitReport } from "../src/modules/saas/service.js";

// Prova o wiring da franquia de créditos IA: contratos e overrides ROOT não
// criam períodos ilimitados nem trocam a unidade dos relatórios.
const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const tenants: string[] = [], plans: string[] = [], users: string[] = [];
const suffix = randomUUID();
const rootEmail = `credit-wiring-root-${suffix}@test.local`;
const passwordHash = await hash("credit-wiring-42", 10);
const app = buildApp();

async function plan(opts: { credits?: number; interactions?: number }) {
  const id = (await pool.query<{ id: string }>("INSERT INTO plans(code,name,billing_period_months,monthly_price_cents,rollover_enabled,rollover_rate_bps,rollover_max_percentage_bps) VALUES($1,$1,1,0,true,10000,10000) RETURNING id", [`CW_${randomUUID()}`])).rows[0].id;
  plans.push(id);
  if (opts.credits !== undefined) await pool.query("INSERT INTO plan_limits(plan_id,limit_key,limit_value) VALUES($1,'MAX_AI_CREDITS',$2)", [id, opts.credits]);
  if (opts.interactions !== undefined) await pool.query("INSERT INTO plan_limits(plan_id,limit_key,limit_value) VALUES($1,'MAX_AI_INTERACTIONS',$2)", [id, opts.interactions]);
  await pool.query("INSERT INTO plan_prices(plan_id,billing_cycle,base_price_cents,final_price_cents,currency,active) VALUES($1,'MONTHLY',0,0,'BRL',true)", [id]);
  return id;
}
async function tenant(planId: string) {
  const id = (await pool.query<{ id: string }>("INSERT INTO tenants(name,slug,status) VALUES($1,$1,'active') RETURNING id", [`credit-wiring-${randomUUID()}`])).rows[0].id;
  tenants.push(id);
  await pool.query("INSERT INTO tenant_subscriptions(tenant_id,plan_id,status,current_period_start,current_period_end) VALUES($1,$2,'ACTIVE',now()-interval '10 days',now()+interval '20 days')", [id, planId]);
  return id;
}
async function legacyOpenPeriod(t: string, limit: number, usage = 0) {
  await pool.query("INSERT INTO usage_periods(tenant_id,subscription_id,sequence,start_at,end_at,included_limit,included_usage,status) VALUES($1,(SELECT id FROM tenant_subscriptions WHERE tenant_id=$1),1,now()-interval '10 days',now()+interval '20 days',$2,$3,'OPEN')", [t, limit, usage]);
}
async function openPeriod(t: string) {
  return (await pool.query<{ usage_unit: string; included_limit: string | null; included_usage: string; id: string }>("SELECT usage_unit,included_limit,included_usage,id FROM usage_periods WHERE tenant_id=$1 AND status='OPEN'", [t])).rows[0];
}

beforeAll(async () => {
  await app.ready();
  await pool.query("INSERT INTO users(email,password_hash,status,is_root) VALUES($1,$2,'active',true)", [rootEmail, passwordHash]);
  users.push((await pool.query<{ id: string }>("SELECT id FROM users WHERE email=$1", [rootEmail])).rows[0].id);
});
afterAll(async () => {
  if (tenants.length) await pool.query("DELETE FROM tenant_entitlement_overrides WHERE tenant_id=ANY($1::uuid[])", [tenants]);
  if (tenants.length) await pool.query("DELETE FROM tenants WHERE id=ANY($1::uuid[])", [tenants]);
  if (plans.length) await pool.query("DELETE FROM plans WHERE id=ANY($1::uuid[])", [plans]);
  if (users.length) {
    await pool.query("UPDATE audit_logs SET actor_user_id=NULL WHERE actor_user_id=ANY($1::uuid[])", [users]);
    await pool.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [users]);
  }
  await app.close();
  await pool.end();
});

describe("AI credit franchise wiring", () => {
  it("contrato novo em plano de créditos nasce período CREDIT com o limite do plano", async () => {
    const basic = await plan({ credits: 1_000_000 });
    const t = await tenant(basic);
    await contractPlanForTenant(t, basic, "MONTHLY", "");
    const p = await openPeriod(t);
    expect(p.usage_unit).toBe("CREDIT");
    expect(Number(p.included_limit)).toBe(1_000_000);
  });

  it("contrato em plano legado nasce INTERACTION com o limite de interações", async () => {
    const legacy = await plan({ interactions: 100 });
    const t = await tenant(legacy);
    await contractPlanForTenant(t, legacy, "MONTHLY", "");
    const p = await openPeriod(t);
    expect(p.usage_unit).toBe("INTERACTION");
    expect(Number(p.included_limit)).toBe(100);
  });

  it("upgrade com ciclo vigente preserva período, cota e consumo", async () => {
    const oldPlan = await plan({ interactions: 100 });
    const next = await plan({ credits: 1_000_000 });
    const t = await tenant(oldPlan);
    await legacyOpenPeriod(t, 100, 42);
    await contractPlanForTenant(t, next, "MONTHLY", "");
    const p = await openPeriod(t);
    expect(p.usage_unit).toBe("INTERACTION");
    expect(Number(p.included_limit)).toBe(100);
    expect(Number(p.included_usage)).toBe(42);
  });

  it("override ROOT de MAX_AI_CREDITS altera o snapshot aberto e remover restaura", async () => {
    const credits = await plan({ credits: 1_000_000 });
    const t = await tenant(credits);
    await contractPlanForTenant(t, credits, "MONTHLY", "");
    const login = await app.inject({ method: "POST", url: "/auth/login", payload: { email: rootEmail, password: "credit-wiring-42" } });
    const cookie = (Array.isArray(login.headers["set-cookie"]) ? login.headers["set-cookie"][0] : login.headers["set-cookie"])!.split(";")[0];
    const grant = await app.inject({ method: "PUT", url: `/root/saas/tenants/${t}/overrides/limit/MAX_AI_CREDITS`, headers: { cookie }, payload: { intValue: 500 } });
    expect(grant.statusCode).toBe(200);
    expect(Number((await openPeriod(t)).included_limit)).toBe(500);
    // Override da unidade legada não pode contaminar o período CREDIT.
    const legacyGrant = await app.inject({ method: "PUT", url: `/root/saas/tenants/${t}/overrides/limit/MAX_AI_INTERACTIONS`, headers: { cookie }, payload: { intValue: 7 } });
    expect(legacyGrant.statusCode).toBe(200);
    expect(Number((await openPeriod(t)).included_limit)).toBe(500);
    const remove = await app.inject({ method: "DELETE", url: `/root/saas/tenants/${t}/overrides/limit/MAX_AI_CREDITS`, headers: { cookie } });
    expect(remove.statusCode).toBe(200);
    expect(Number((await openPeriod(t)).included_limit)).toBe(1_000_000);
  });

  it("edição do limite do plano propaga a períodos CREDIT abertos, override por empresa prevalece", async () => {
    const credits = await plan({ credits: 1_000_000 });
    const t = await tenant(credits);
    await contractPlanForTenant(t, credits, "MONTHLY", "");
    const tOverride = await tenant(credits);
    await contractPlanForTenant(tOverride, credits, "MONTHLY", "");
    const login = await app.inject({ method: "POST", url: "/auth/login", payload: { email: rootEmail, password: "credit-wiring-42" } });
    const cookie = (Array.isArray(login.headers["set-cookie"]) ? login.headers["set-cookie"][0] : login.headers["set-cookie"])!.split(";")[0];
    await app.inject({ method: "PUT", url: `/root/saas/tenants/${tOverride}/overrides/limit/MAX_AI_CREDITS`, headers: { cookie }, payload: { intValue: 500 } });
    const patch = await app.inject({ method: "PATCH", url: `/root/saas/plans/${credits}`, headers: { cookie }, payload: { limits: { MAX_AI_CREDITS: 2_000_000 } } });
    expect(patch.statusCode).toBe(200);
    expect(Number((await openPeriod(t)).included_limit)).toBe(2_000_000);
    expect(Number((await openPeriod(tOverride)).included_limit)).toBe(500);
  });

  it("relatório da empresa mostra créditos sem converter interação antiga", async () => {
    const credits = await plan({ credits: 1_000_000 });
    const tCredit = await tenant(credits);
    await contractPlanForTenant(tCredit, credits, "MONTHLY", "");
    await pool.query("UPDATE usage_periods SET included_usage=1500000 WHERE tenant_id=$1", [tCredit]);
    const legacy = await plan({ interactions: 100 });
    const tLegacy = await tenant(legacy);
    await legacyOpenPeriod(tLegacy, 100, 150);
    expect(await getOverLimitReport(tCredit)).toEqual(["MAX_AI_CREDITS"]);
    expect(await getOverLimitReport(tLegacy)).toEqual(["MAX_AI_INTERACTIONS"]);
    const login = await app.inject({ method: "POST", url: "/auth/login", payload: { email: rootEmail, password: "credit-wiring-42" } });
    const cookie = (Array.isArray(login.headers["set-cookie"]) ? login.headers["set-cookie"][0] : login.headers["set-cookie"])!.split(";")[0];
    const detail = await app.inject({ url: `/root/saas/tenants/${tCredit}`, headers: { cookie } });
    const body = detail.json<{ usage: Record<string, number> }>();
    expect(body.usage.MAX_AI_CREDITS).toBe(1_500_000);
    expect(body.usage.MAX_AI_INTERACTIONS).toBe(0);
    const legacyDetail = await app.inject({ url: `/root/saas/tenants/${tLegacy}`, headers: { cookie } });
    const legacyBody = legacyDetail.json<{ usage: Record<string, number> }>();
    expect(legacyBody.usage.MAX_AI_INTERACTIONS).toBe(150);
    expect(legacyBody.usage.MAX_AI_CREDITS).toBe(0);
  });
});
