import { randomUUID } from "node:crypto";
import { hash } from "bcryptjs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";
import { consumeAiInteraction } from "../src/billing/ai-consumption.js";
import { grantUsageCredit } from "../src/billing/ledger.js";
import { ensureOpenPeriod } from "../src/billing/usage-period.js";

/**
 * Bônus ROOT (/root/billing/tenants/:tenantId/bonus) e o helper
 * grantUsageCredit precisam nascer com a MESMA usage_unit do período aberto:
 * o consumo (consumeAiInteraction) só debita grants na unidade do período,
 * então uma grant INTERACTION em período CREDIT ficava inutilizável enquanto
 * bonus_granted inflava. Períodos legados INTERACTION permanecem INTERACTION.
 */
const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const app = buildApp();
const suffix = randomUUID();
const password = "root-bonus-test";
const rootEmail = `bonus-root-${suffix}@test.local`;
let tenantCredit = "";
let tenantLegacy = "";
let rootCookie = "";
const plans: string[] = [];

async function tenant(label: string): Promise<string> {
  const slug = `root-bonus-${label}-${randomUUID()}`;
  return (await pool.query<{ id: string }>("INSERT INTO tenants(name,slug,status) VALUES($1,$2,'active') RETURNING id", [slug, slug])).rows[0].id;
}
async function plan(opts: { interactions?: number; credits?: number }): Promise<string> {
  const code = `ROOT_BONUS_${randomUUID()}`;
  const p = (await pool.query<{ id: string }>("INSERT INTO plans(code,name,billing_period_months,monthly_price_cents,ai_enabled) VALUES($1,$2,1,0,true) RETURNING id", [code, code])).rows[0].id;
  plans.push(p);
  if (opts.interactions !== undefined) await pool.query("INSERT INTO plan_limits(plan_id,limit_key,limit_value) VALUES($1,'MAX_AI_INTERACTIONS',$2)", [p, opts.interactions]);
  if (opts.credits !== undefined) await pool.query("INSERT INTO plan_limits(plan_id,limit_key,limit_value) VALUES($1,'MAX_AI_CREDITS',$2)", [p, opts.credits]);
  return p;
}
async function subscribe(t: string, p: string): Promise<void> {
  await pool.query("INSERT INTO tenant_subscriptions(tenant_id,plan_id,status,current_period_start,current_period_end) VALUES($1,$2,'ACTIVE',now(),now()+interval '1 month')", [t, p]);
}
async function period(t: string) {
  const c = await pool.connect();
  try { await c.query("BEGIN"); await c.query("SELECT id FROM tenant_subscriptions WHERE tenant_id=$1 FOR UPDATE", [t]); const r = await ensureOpenPeriod(c, t); await c.query("COMMIT"); return r!; }
  catch (e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
}
const periodOf = async (t: string) => (await pool.query<{ id: string; usage_unit: string; bonus_granted: string; bonus_usage: string }>("SELECT id,usage_unit,bonus_granted,bonus_usage FROM usage_periods WHERE tenant_id=$1 AND status='OPEN'", [t])).rows[0];
const grantsOf = async (t: string) => (await pool.query<{ kind: string; usage_unit: string; amount: string; consumed_amount: string }>("SELECT kind,usage_unit,amount,consumed_amount FROM usage_grants WHERE tenant_id=$1", [t])).rows;

beforeAll(async () => {
  await app.ready();
  tenantCredit = await tenant("credit");
  await subscribe(tenantCredit, await plan({ credits: 40_000 }));
  await period(tenantCredit);
  tenantLegacy = await tenant("legacy");
  await subscribe(tenantLegacy, await plan({ interactions: 2 }));
  await period(tenantLegacy);
  await pool.query("INSERT INTO users(email,password_hash,status,is_root) VALUES($1,$2,'active',true)", [rootEmail, await hash(password, 4)]);
  const login = await app.inject({ method: "POST", url: "/auth/login", payload: { email: rootEmail, password } });
  expect(login.statusCode).toBe(200);
  const cookie = login.headers["set-cookie"]!;
  rootCookie = (Array.isArray(cookie) ? cookie[0] : cookie).split(";")[0];
});

afterAll(async () => {
  const ids = [tenantCredit, tenantLegacy].filter(Boolean);
  if (ids.length) {
    await pool.query("DELETE FROM audit_logs WHERE workspace_id=ANY($1::uuid[])", [ids]);
    await pool.query("DELETE FROM tenants WHERE id=ANY($1::uuid[])", [ids]);
  }
  // Planos ROOT_BONUS_ (e plan_limits, em cascata) saem junto: sem isso vazam
  // no banco compartilhado e poluem suítes que contratam o primeiro plano
  // ativo por position (saas-foundation).
  if (plans.length) await pool.query("DELETE FROM plans WHERE id=ANY($1::uuid[])", [plans]);
  if (rootEmail) await pool.query("DELETE FROM users WHERE email=$1", [rootEmail]);
  await app.close();
  await pool.end();
});

describe("bônus ROOT e helper nascem na unidade do período aberto", () => {
  it("bônus ROOT em período CREDIT nasce CREDIT, é consumível e o contador fica alinhado", async () => {
    const amount = 10_000_000;
    const r = await app.inject({ method: "POST", url: `/root/billing/tenants/${tenantCredit}/bonus`, headers: { cookie: rootCookie }, payload: { amount, reason: "bônus de cortesia" } });
    expect(r.statusCode).toBe(200);
    expect(r.json().grant).toMatchObject({ usage_unit: "CREDIT", amount: String(amount) });
    expect(await periodOf(tenantCredit)).toMatchObject({ usage_unit: "CREDIT", bonus_granted: String(amount) });
    // Consumo cai no bônus (sem rollover) e debita a GRANT — não só o contador.
    const reservation = await consumeAiInteraction(tenantCredit, "inbound_reply", randomUUID());
    expect(reservation).toMatchObject({ allowed: true, consumptionType: "BONUS" });
    const [grant] = await grantsOf(tenantCredit);
    expect(grant).toMatchObject({ kind: "BONUS", usage_unit: "CREDIT" });
    expect(Number(grant.consumed_amount)).toBeGreaterThan(0);
    expect(await periodOf(tenantCredit)).toMatchObject({ bonus_usage: grant.consumed_amount, bonus_granted: String(amount) });
  });

  it("período legado INTERACTION preserva grant INTERACTION", async () => {
    const r = await app.inject({ method: "POST", url: `/root/billing/tenants/${tenantLegacy}/bonus`, headers: { cookie: rootCookie }, payload: { amount: 3, reason: "bônus legado" } });
    expect(r.statusCode).toBe(200);
    expect(r.json().grant).toMatchObject({ usage_unit: "INTERACTION", amount: "3" });
    expect(await periodOf(tenantLegacy)).toMatchObject({ usage_unit: "INTERACTION", bonus_granted: "3" });
  });

  it("helper grantUsageCredit deriva a unidade do período e mantém idempotência", async () => {
    const credit = await periodOf(tenantCredit);
    const legacy = await periodOf(tenantLegacy);
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT id FROM tenant_subscriptions WHERE tenant_id=$1 FOR UPDATE", [tenantCredit]);
      const key = `helper-${randomUUID()}`;
      const g = await grantUsageCredit(c, { tenantId: tenantCredit, usagePeriodId: credit.id, amount: 500_000, reason: "helper", idempotencyKey: key });
      expect(g).toMatchObject({ usage_unit: "CREDIT", amount: "500000" });
      // Ler pelo MESMO client: o pool não vê o incremento não-commitado da transação.
      const grantedOf = async (client: pg.PoolClient, periodId: string) => Number((await client.query<{ bonus_granted: string }>("SELECT bonus_granted FROM usage_periods WHERE id=$1", [periodId])).rows[0].bonus_granted);
      const granted = Number(credit.bonus_granted) + 500_000;
      expect(await grantedOf(c, credit.id)).toBe(granted);
      // Idempotência: repetição não duplica grant nem contador.
      expect(await grantUsageCredit(c, { tenantId: tenantCredit, usagePeriodId: credit.id, amount: 500_000, reason: "helper", idempotencyKey: key })).toBeNull();
      expect(await grantedOf(c, credit.id)).toBe(granted);
      const gl = await grantUsageCredit(c, { tenantId: tenantLegacy, usagePeriodId: legacy.id, amount: 5, reason: "helper legado", idempotencyKey: `helper-${randomUUID()}` });
      expect(gl).toMatchObject({ usage_unit: "INTERACTION", amount: "5" });
      await c.query("COMMIT");
    } catch (error) { await c.query("ROLLBACK").catch(() => {}); throw error; } finally { c.release(); }
  });
});
