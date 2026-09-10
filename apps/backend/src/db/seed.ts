import { hash } from "bcryptjs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import type { Pool } from "pg";
import { config, type AppConfig } from "../config.js";
import { db } from "./client.js";
import { ensurePermissionCatalog, ensureWorkspaceDefaultRoles } from "../auth/rbac.js";
import { DEFAULT_MEDIA_FALLBACK } from "../modules/ai-router/defaults.js";
import { DEFAULT_HUMANIZER_CONFIG } from "../modules/messages/humanizer.js";

type SeedConfig = Pick<AppConfig,
  "PANEL_SEED_EMAIL" | "PANEL_SEED_PASSWORD" | "DEFAULT_SYSTEM_PROMPT" | "DEFAULT_AI_MODEL" | "ROOT_SEED_EMAIL" | "ROOT_SEED_PASSWORD"
>;

export async function seedDatabase(pool: Pool, seedConfig: SeedConfig) {
  const client = await pool.connect();
  const email = seedConfig.PANEL_SEED_EMAIL.toLowerCase();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [email]);
    await ensurePermissionCatalog(client);

    const existing = await client.query<{ user_id: string; tenant_id: string }>(
      `SELECT u.id user_id,m.workspace_id tenant_id
       FROM users u
       JOIN workspace_members m ON m.user_id=u.id
       JOIN tenants t ON t.id=m.workspace_id
       WHERE u.email=$1
       ORDER BY t.created_at,m.created_at
       LIMIT 1`,
      [email]
    );
    let tenantId = existing.rows[0]?.tenant_id;
    const passwordHash = await hash(seedConfig.PANEL_SEED_PASSWORD, 12);

    if (!tenantId) {
      const tenant = await client.query<{ id: string }>(
        "INSERT INTO tenants (name, slug, status) VALUES ('Tenant local', 'tenant-local-' || left(gen_random_uuid()::text, 8), 'active') RETURNING id"
      );
      tenantId = tenant.rows[0].id;
    }

    await ensureWorkspaceDefaultRoles(client, tenantId);
    const seededUser = await client.query<{ id: string }>(
      `INSERT INTO users(email,password_hash,status,is_root)
       VALUES($1,$2,'active',false)
       ON CONFLICT(email) DO UPDATE SET
         password_hash=COALESCE(users.password_hash,EXCLUDED.password_hash),
         status=CASE WHEN users.status='disabled' THEN users.status ELSE 'active' END,
         updated_at=now()
       RETURNING id`,
      [email, passwordHash]
    );
    await client.query(
      `INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at)
       SELECT $1,$2,id,'active',now() FROM workspace_roles
       WHERE workspace_id=$1 AND name='OWNER'
       ON CONFLICT(workspace_id,user_id) DO UPDATE SET
         role_id=EXCLUDED.role_id,
         status='active',
         joined_at=COALESCE(workspace_members.joined_at,now()),
         updated_at=now()`,
      [tenantId, seededUser.rows[0].id]
    );
    await client.query("UPDATE tenants SET created_by_user_id=COALESCE(created_by_user_id,$2),updated_at=now() WHERE id=$1", [tenantId, seededUser.rows[0].id]);

    const insertedSession = await client.query<{ id: string }>(
      `INSERT INTO whatsapp_sessions (tenant_id,label,is_primary)
       SELECT $1,'Principal',true WHERE NOT EXISTS (SELECT 1 FROM whatsapp_sessions WHERE tenant_id=$1)
       RETURNING id`,
      [tenantId]
    );
    const sessionId = insertedSession.rows[0]?.id ?? (await client.query<{ id: string }>(
      `SELECT id FROM whatsapp_sessions WHERE tenant_id=$1 AND archived_at IS NULL
       ORDER BY is_primary DESC, created_at LIMIT 1`,
      [tenantId]
    )).rows[0].id;

    await client.query(
      `INSERT INTO agent_configs (tenant_id, system_prompt, ai_model, model_params)
       SELECT $1, $2, $3, $4 WHERE NOT EXISTS (SELECT 1 FROM agent_configs WHERE tenant_id=$1)`,
      [tenantId, seedConfig.DEFAULT_SYSTEM_PROMPT, seedConfig.DEFAULT_AI_MODEL, { temperature: 0.4, max_tokens: 512 }]
    );
    await client.query(
      `INSERT INTO tenant_ai_settings (tenant_id, media_fallback_audio, media_fallback_image, media_fallback_document, humanizer_config)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT (tenant_id) DO NOTHING`,
      [tenantId, DEFAULT_MEDIA_FALLBACK.audio, DEFAULT_MEDIA_FALLBACK.image, DEFAULT_MEDIA_FALLBACK.document, DEFAULT_HUMANIZER_CONFIG]
    );
    if (seedConfig.ROOT_SEED_EMAIL && seedConfig.ROOT_SEED_PASSWORD) {
      const rootEmail = seedConfig.ROOT_SEED_EMAIL.toLocaleLowerCase("en-US");
      const root = await client.query<{ id: string }>(
        `INSERT INTO users(email,password_hash,status,is_root)
         VALUES($1,$2,'active',true)
         ON CONFLICT(email) DO UPDATE SET
           is_root=true,
           status=CASE WHEN users.status='disabled' THEN users.status ELSE 'active' END,
           password_hash=COALESCE(users.password_hash,EXCLUDED.password_hash),
           updated_at=now()
         RETURNING id`,
        [rootEmail, await hash(seedConfig.ROOT_SEED_PASSWORD, 12)]
      );
      const existingRootWorkspace = await client.query<{ workspace_id: string }>(
        "SELECT workspace_id FROM workspace_members WHERE user_id=$1 LIMIT 1",
        [root.rows[0].id]
      );
      if (!existingRootWorkspace.rows[0]) {
        const rootTenant = await client.query<{ id: string }>(
          "INSERT INTO tenants (name, slug, status, created_by_user_id) VALUES ('Workspace Root', 'root-' || left(gen_random_uuid()::text, 8), 'active', $1) RETURNING id",
          [root.rows[0].id]
        );
        await ensureWorkspaceDefaultRoles(client, rootTenant.rows[0].id);
        await client.query(
          `INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at)
           SELECT $1,$2,id,'active',now() FROM workspace_roles
           WHERE workspace_id=$1 AND name='OWNER'`,
          [rootTenant.rows[0].id, root.rows[0].id]
        );
      }
      await client.query(
        `INSERT INTO audit_logs(actor_user_id,actor_scope,action,resource_type,resource_id,metadata)
         VALUES($1,'root','root.seed','user',$2,$3)`,
        [root.rows[0].id, root.rows[0].id, { email: rootEmail }]
      );
    }
    await client.query("COMMIT");
    return { tenantId, sessionId, email };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

const isEntrypoint = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isEntrypoint) {
  try {
    const result = await seedDatabase(db, config);
    console.log(`Seeded tenant ${result.tenantId}, session ${result.sessionId}, user ${result.email}`);
  } finally {
    await db.end();
  }
}
