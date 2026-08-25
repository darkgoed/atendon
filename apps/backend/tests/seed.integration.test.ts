import { randomUUID } from "node:crypto";
import { compare } from "bcryptjs";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { seedDatabase } from "../src/db/seed.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const email = `seed-${randomUUID()}@test.local`;
const rootEmail = `root-seed-${randomUUID()}@test.local`;
let tenantId: string | undefined;

afterAll(async () => {
  await pool.query("DELETE FROM audit_logs WHERE actor_user_id IN (SELECT id FROM users WHERE email=$1)", [rootEmail]);
  await pool.query("DELETE FROM users WHERE email=$1", [rootEmail]);
  if (tenantId) await pool.query("DELETE FROM tenants WHERE id=$1", [tenantId]);
  await pool.end();
});

describe("database seed", () => {
  it("is idempotent and reuses the original tenant, session, and agent", async () => {
    const seedConfig = { ...config, PANEL_SEED_EMAIL: email, PANEL_SEED_PASSWORD: "first-password" };
    const first = await seedDatabase(pool, seedConfig);
    tenantId = first.tenantId;
    const second = await seedDatabase(pool, { ...seedConfig, PANEL_SEED_PASSWORD: "updated-password" });

    expect(second.tenantId).toBe(first.tenantId);
    expect(second.sessionId).toBe(first.sessionId);
    const result = await pool.query<{ users: number; members: number; sessions: number; agents: number }>(
      `SELECT
        (SELECT count(*)::int FROM users WHERE lower(email)=lower($1)) users,
        (SELECT count(*)::int FROM workspace_members m JOIN users u ON u.id=m.user_id WHERE lower(u.email)=lower($1) AND m.workspace_id=$2) members,
        (SELECT count(*)::int FROM whatsapp_sessions WHERE tenant_id=$2) sessions,
        (SELECT count(*)::int FROM agent_configs WHERE tenant_id=$2) agents`,
      [email, tenantId]
    );
    expect(result.rows[0]).toEqual({ users: 1, members: 1, sessions: 1, agents: 1 });
  });

  it("creates the first ROOT idempotently without silently rotating its password", async () => {
    const rootConfig = {
      ...config,
      PANEL_SEED_EMAIL: email,
      PANEL_SEED_PASSWORD: "first-password",
      ROOT_SEED_EMAIL: rootEmail,
      ROOT_SEED_PASSWORD: "initial-root-password"
    };
    await seedDatabase(pool, rootConfig);
    await seedDatabase(pool, { ...rootConfig, ROOT_SEED_PASSWORD: "different-root-password" });

    const root = await pool.query<{ password_hash: string; is_root: boolean; status: string; audit_count: number }>(
      `SELECT u.password_hash,u.is_root,u.status,
              (SELECT count(*)::int FROM audit_logs WHERE actor_user_id=u.id AND action='root.seed') audit_count
       FROM users u WHERE email=$1`,
      [rootEmail]
    );
    expect(root.rows[0]).toMatchObject({ is_root: true, status: "active" });
    expect(root.rows[0].audit_count).toBe(2);
    await expect(compare("initial-root-password", root.rows[0].password_hash)).resolves.toBe(true);
    await expect(compare("different-root-password", root.rows[0].password_hash)).resolves.toBe(false);
  }, 10_000);
});
