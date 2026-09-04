import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { assertLimitWithinTransaction } from "../src/billing/limits.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const tenants: string[] = [];
async function fixture(label: string) {
  const id = (await pool.query<{ id: string }>("INSERT INTO tenants(name,slug,status) VALUES($1,$2,'active') RETURNING id", [`concurrency-${label}-${randomUUID()}`, `concurrency-${label}-${randomUUID()}`])).rows[0].id;
  tenants.push(id);
  const plan = (await pool.query<{ id: string }>("SELECT id FROM plans WHERE code='BASIC'")).rows[0].id;
  await pool.query("INSERT INTO tenant_subscriptions(tenant_id,plan_id,status,current_period_start,current_period_end) VALUES($1,$2,'ACTIVE',now(),now()+interval '1 day')", [id, plan]);
  const role = (await pool.query<{ id: string }>("INSERT INTO workspace_roles(workspace_id,name) VALUES($1,$2) RETURNING id", [id, `member-${randomUUID()}`])).rows[0].id;
  return { id, role };
}
async function race(tenantId: string, key: string, insert: (c: pg.PoolClient) => Promise<void>) {
  const clients = [await pool.connect(), await pool.connect()];
  try {
    await Promise.all(clients.map(c => c.query("BEGIN")));
    const results = await Promise.all(clients.map(async c => {
      try { await assertLimitWithinTransaction(c, tenantId, key, 1); await insert(c); await c.query("COMMIT"); return "success"; }
      catch (e) { await c.query("ROLLBACK"); return (e as { code?: string }).code ?? "error"; }
    }));
    return results;
  } finally { clients.forEach(c => c.release()); }
}
afterAll(async () => { if (tenants.length) await pool.query("DELETE FROM tenants WHERE id=ANY($1::uuid[])", [tenants]); await pool.end(); });

describe("billing limit concurrency", () => {
  it("serializes WhatsApp connection limit", async () => {
    const { id } = await fixture("whatsapp");
    const results = await race(id, "MAX_WHATSAPP_CONNECTIONS", async c => { await c.query("INSERT INTO whatsapp_sessions(tenant_id) VALUES($1)", [id]); });
    expect(results.filter(x => x === "success")).toHaveLength(1);
    expect(results.filter(x => x === "PLAN_LIMIT_REACHED")).toHaveLength(1);
    expect((await pool.query("SELECT count(*)::int AS n FROM whatsapp_sessions WHERE tenant_id=$1", [id])).rows[0].n).toBe(1);
  });
  it("serializes MAX_USERS at the boundary", async () => {
    const { id, role } = await fixture("users");
    for (let i = 0; i < 2; i++) { const u = (await pool.query<{ id: string }>("INSERT INTO users(email,status) VALUES($1,'active') RETURNING id", [`seed-${randomUUID()}@test.invalid`])).rows[0].id; await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at) VALUES($1,$2,$3,'active',now())", [id, u, role]); }
    const results = await race(id, "MAX_USERS", async c => { const u = (await c.query<{ id: string }>("INSERT INTO users(email,status) VALUES($1,'active') RETURNING id", [`race-${randomUUID()}@test.invalid`])).rows[0].id; await c.query("INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at) VALUES($1,$2,$3,'active',now())", [id, u, role]); });
    expect(results.filter(x => x === "success")).toHaveLength(1);
    expect(results.filter(x => x === "PLAN_LIMIT_REACHED")).toHaveLength(1);
    expect((await pool.query("SELECT count(*)::int AS n FROM workspace_members WHERE workspace_id=$1 AND status='active'", [id])).rows[0].n).toBe(3);
  });
});
