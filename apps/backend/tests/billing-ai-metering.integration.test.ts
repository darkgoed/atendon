import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { AI_INTERACTION_METRIC, canConsumeAiInteraction, recordAiInteraction } from "../src/billing/ai-metering.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const createdTenants: string[] = [];

async function createTenant(label: string) {
  const suffix = randomUUID();
  const result = await pool.query<{ id: string }>("INSERT INTO tenants(name,slug,status) VALUES($1,$2,'active') RETURNING id", [`billing-ai-${label}-${suffix}`, `billing-ai-${label}-${suffix}`]);
  createdTenants.push(result.rows[0].id);
  return result.rows[0].id;
}
async function planId(code: string) { return (await pool.query<{ id: string }>("SELECT id FROM plans WHERE code=$1", [code])).rows[0].id; }
async function subscribe(tenantId: string, code: string) {
  const start = new Date();
  await pool.query("INSERT INTO tenant_subscriptions(tenant_id,plan_id,status,current_period_start,current_period_end) VALUES($1,$2,'ACTIVE',$3,$4)", [tenantId, await planId(code), start, new Date(start.getTime() + 86400000)]);
}
async function usage(tenantId: string, periodStart?: Date) {
  const result = await pool.query<{ used: string }>("SELECT used FROM usage_counters WHERE tenant_id=$1 AND metric_key=$2 AND period_start=$3", [tenantId, AI_INTERACTION_METRIC, periodStart ?? (await pool.query<{ current_period_start: Date }>("SELECT current_period_start FROM tenant_subscriptions WHERE tenant_id=$1", [tenantId])).rows[0].current_period_start]);
  return Number(result.rows[0]?.used ?? 0);
}
async function cleanup(tenantId: string) { await pool.query("DELETE FROM tenants WHERE id=$1", [tenantId]); const i = createdTenants.indexOf(tenantId); if (i >= 0) createdTenants.splice(i, 1); }

afterAll(async () => { if (createdTenants.length) await pool.query("DELETE FROM tenants WHERE id=ANY($1::uuid[])", [createdTenants]); await pool.end(); });

describe("AI metering integration", () => {
  it("increments usage once for one turn", async () => { const id = await createTenant("once"); const c = await pool.connect(); try { await subscribe(id, "MEDIUM"); await recordAiInteraction(c, id, "inbound_reply", "turn-1"); expect(await usage(id)).toBe(1); } finally { c.release(); await cleanup(id); } });
  it("is idempotent for the same logical turn", async () => { const id = await createTenant("idempotent"); const c = await pool.connect(); try { await subscribe(id, "MEDIUM"); await recordAiInteraction(c, id, "inbound_reply", "turn-1"); await recordAiInteraction(c, id, "inbound_reply", "turn-1"); expect(await usage(id)).toBe(1); } finally { c.release(); await cleanup(id); } });
  it("counts different logical turns separately", async () => { const id = await createTenant("different"); const c = await pool.connect(); try { await subscribe(id, "MEDIUM"); await recordAiInteraction(c, id, "inbound_reply", "turn-1"); await recordAiInteraction(c, id, "inbound_reply", "turn-2"); expect(await usage(id)).toBe(2); } finally { c.release(); await cleanup(id); } });
  it("allows MEDIUM and denies BASIC", async () => { const basic = await createTenant("basic"); const medium = await createTenant("medium"); try { await subscribe(basic, "BASIC"); await subscribe(medium, "MEDIUM"); expect(await canConsumeAiInteraction(basic)).toBe(false); expect(await canConsumeAiInteraction(medium)).toBe(true); } finally { await cleanup(basic); await cleanup(medium); } });
  it("denies MEDIUM at its quota", async () => { const id = await createTenant("quota"); try { await subscribe(id, "MEDIUM"); await pool.query("INSERT INTO usage_counters(tenant_id,period_start,period_end,metric_key,used) SELECT tenant_id,current_period_start,current_period_end,$2,10000 FROM tenant_subscriptions WHERE tenant_id=$1", [id, AI_INTERACTION_METRIC]); expect(await canConsumeAiInteraction(id)).toBe(false); } finally { await cleanup(id); } });
  it("keeps the prior period counter when the period changes", async () => { const id = await createTenant("period"); const c = await pool.connect(); try { await subscribe(id, "MEDIUM"); await recordAiInteraction(c, id, "inbound_reply", "old-turn"); const old = (await pool.query<{ current_period_start: Date }>("SELECT current_period_start FROM tenant_subscriptions WHERE tenant_id=$1", [id])).rows[0].current_period_start; const next = new Date(old.getTime() + 86400000); await pool.query("UPDATE tenant_subscriptions SET current_period_start=$2,current_period_end=$3 WHERE tenant_id=$1", [id, next, new Date(next.getTime() + 86400000)]); expect(await usage(id)).toBe(0); expect(await usage(id, old)).toBe(1); } finally { c.release(); await cleanup(id); } });
});
