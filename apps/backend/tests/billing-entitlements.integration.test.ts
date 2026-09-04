import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { assertFeature, getEffectiveEntitlements } from "../src/billing/entitlements.js";
import { assertLimitWithinTransaction } from "../src/billing/limits.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const createdTenants: string[] = [];

async function createTenant(label: string) {
  const suffix = randomUUID();
  const result = await pool.query<{ id: string }>(
    "INSERT INTO tenants(name,slug,status) VALUES($1,$2,'active') RETURNING id",
    [`billing-${label}-${suffix}`, `billing-${label}-${suffix}`]
  );
  const id = result.rows[0].id;
  createdTenants.push(id);
  return id;
}
async function planId(code: string) {
  return (await pool.query<{ id: string }>("SELECT id FROM plans WHERE code=$1", [code])).rows[0].id;
}
async function subscribe(tenantId: string, code: string, status = "ACTIVE") {
  const start = new Date();
  await pool.query(
    "INSERT INTO tenant_subscriptions(tenant_id,plan_id,status,current_period_start,current_period_end) VALUES($1,$2,$3,$4,$5)",
    [tenantId, await planId(code), status, start, new Date(start.getTime() + 86400000)]
  );
}
async function cleanup(tenantId: string) {
  await pool.query("DELETE FROM tenants WHERE id=$1", [tenantId]);
  createdTenants.splice(createdTenants.indexOf(tenantId), 1);
}

afterAll(async () => {
  if (createdTenants.length) await pool.query("DELETE FROM tenants WHERE id=ANY($1::uuid[])", [createdTenants]);
  await pool.end();
});

describe("billing entitlements integration", () => {
  it("applies BASIC feature matrix", async () => {
    const id = await createTenant("basic");
    try { await subscribe(id, "BASIC"); const e = await getEffectiveEntitlements(id); expect(e.features).toMatchObject({ CALENDAR: false, AI: false, CONVERSATIONS: true }); }
    finally { await cleanup(id); }
  });

  it("applies MEDIUM features and plan limits", async () => {
    const id = await createTenant("medium");
    try { await subscribe(id, "MEDIUM"); const e = await getEffectiveEntitlements(id); expect(e.features.AI).toBe(true); expect(e.limits.MAX_USERS).toBe(8); }
    finally { await cleanup(id); }
  });

  it("applies a non-expired limit override", async () => {
    const id = await createTenant("override");
    try { await subscribe(id, "MEDIUM"); await pool.query("INSERT INTO tenant_entitlement_overrides(tenant_id,kind,entitlement_key,int_value) VALUES($1,'limit','MAX_USERS',12)", [id]); expect((await getEffectiveEntitlements(id)).limits.MAX_USERS).toBe(12); }
    finally { await cleanup(id); }
  });

  it("ignores an expired override", async () => {
    const id = await createTenant("expired");
    try { await subscribe(id, "MEDIUM"); await pool.query("INSERT INTO tenant_entitlement_overrides(tenant_id,kind,entitlement_key,int_value,expires_at) VALUES($1,'limit','MAX_USERS',12,now()-interval '1 second')", [id]); expect((await getEffectiveEntitlements(id)).limits.MAX_USERS).toBe(8); }
    finally { await cleanup(id); }
  });

  it("suspends commercial features but preserves core features", async () => {
    const id = await createTenant("suspended");
    try { await subscribe(id, "BASIC", "SUSPENDED"); const e = await getEffectiveEntitlements(id); expect(e.features.PIPELINE).toBe(false); expect(e.features.CONVERSATIONS).toBe(true); }
    finally { await cleanup(id); }
  });

  it("fails open without a subscription", async () => {
    const id = await createTenant("none");
    try { const e = await getEffectiveEntitlements(id); const f = await pool.query<{ feature_key: string }>("SELECT feature_key FROM feature_catalog WHERE is_future=false"); expect(e.features).toEqual(Object.fromEntries(f.rows.map(x => [x.feature_key, true]))); }
    finally { await cleanup(id); }
  });

  it("assertFeature returns the documented upgrade error", async () => {
    const id = await createTenant("feature-error");
    try { await subscribe(id, "BASIC"); const error = await assertFeature(id, "AI").catch(x => x); expect(error).toMatchObject({ statusCode: 403, code: "FEATURE_NOT_AVAILABLE" }); expect(error.details.requiredPlans.length).toBeGreaterThan(0); }
    finally { await cleanup(id); }
  });

  it("enforces a root override when the plan has no limit row (BUG 4)", async () => {
    const id = await createTenant("bug4");
    const client = await pool.connect();
    try {
      await subscribe(id, "BASIC");
      await client.query("BEGIN");
      const basic = await planId("BASIC");
      await client.query("DELETE FROM plan_limits WHERE plan_id=$1 AND limit_key='MAX_USERS'", [basic]);
      await client.query("INSERT INTO tenant_entitlement_overrides(tenant_id,kind,entitlement_key,int_value) VALUES($1,'limit','MAX_USERS',1)", [id]);
      await expect(assertLimitWithinTransaction(client, id, "MAX_USERS", 2)).rejects.toMatchObject({ code: "PLAN_LIMIT_REACHED" });
      await client.query("ROLLBACK");
    } finally { client.release(); await cleanup(id); }
  });
});
