import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureWorkspaceDefaultRoles } from "../src/auth/rbac.js";
import { createSessionToken } from "../src/auth/session.js";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";

// T6.1: o dashboard não pode escolher uma conexão arquivada como "a mais nova".
// Arquivar a conexão mais recente tem de deixar o status e o resumo agregado
// por tenant apontando apenas para as conexões vivas.
const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const app = buildApp();
const suffix = randomUUID();
let tenantId = "";
let ownerId = "";
let ownerCookie = "";

beforeAll(async () => {
  await app.ready();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    tenantId = (await client.query<{ id: string }>(
      "INSERT INTO tenants(name,slug,status) VALUES($1,$2,'active') RETURNING id",
      [`Dashboard arquivada ${suffix}`, `dashboard-archived-${suffix}`]
    )).rows[0].id;
    await client.query(
      `INSERT INTO tenant_feature_flag_overrides(tenant_id,flag_key,enabled) VALUES
         ($1,'dashboard_v1',true),($1,'dashboard_widgets_v1',true),($1,'leads_v1',true),
         ($1,'pipeline_v1',true),($1,'appointments_v1',true),($1,'workspace_admin_v1',true)
       ON CONFLICT (tenant_id,flag_key) DO UPDATE SET enabled=EXCLUDED.enabled,updated_at=now()`,
      [tenantId]
    );
    await ensureWorkspaceDefaultRoles(client, tenantId);
    ownerId = (await client.query<{ id: string }>(
      "INSERT INTO users(email,status) VALUES($1,'active') RETURNING id",
      [`dashboard-archived-owner-${suffix}@test.local`]
    )).rows[0].id;
    await client.query(
      `INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at)
       SELECT $1,$2,id,'active',now() FROM workspace_roles
       WHERE workspace_id=$1 AND name='OWNER'`,
      [tenantId, ownerId]
    );
    // Primária conectada (mais antiga) e secundária mais nova, conectada, que
    // será arquivada: é exatamente o cenário em que escolher "a mais nova"
    // sem filtrar arquivadas faz o dashboard apontar para uma conexão morta.
    await client.query(
      `INSERT INTO whatsapp_sessions(tenant_id,label,is_primary,status,channel,created_at)
       VALUES
         ($1,'Principal',true,'connected','whatsapp', now() - interval '1 hour'),
         ($1,'Secundária',false,'connected','whatsapp', now())`,
      [tenantId]
    );
    await client.query(
      `UPDATE whatsapp_sessions SET archived_at=now(),status='disconnected'
       WHERE tenant_id=$1 AND label='Secundária'`,
      [tenantId]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  ownerCookie = `atendon_session=${await createSessionToken({
    userId: ownerId,
    tenantId,
    email: `dashboard-archived-owner-${suffix}@test.local`,
    role: "OWNER"
  })}`;
});

afterAll(async () => {
  await pool.query("DELETE FROM tenants WHERE id=$1", [tenantId]);
  await pool.query("DELETE FROM users WHERE id=$1", [ownerId]);
  await pool.end();
  await app.close();
});

describe("GET /dashboard com a conexão mais nova arquivada", () => {
  it("reporta o status das conexões vivas e agrega o resumo por tenant", async () => {
    const response = await app.inject({ url: "/dashboard", headers: { cookie: ownerCookie } });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      connection: { status: "connected" },
      connections_summary: { total: 1, connected: 1, disconnected: 0 }
    });
  });
});
