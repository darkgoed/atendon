import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import type { Pool } from "pg";
import { ensurePermissionCatalog, ensureWorkspaceDefaultRoles } from "../auth/rbac.js";
import { DEFAULT_MEDIA_FALLBACK } from "../modules/ai-router/defaults.js";
import { NEWAVE_ENABLED_TOOL_NAMES } from "../modules/ai-router/tools.js";
import { DEFAULT_HUMANIZER_CONFIG } from "../modules/messages/humanizer.js";
import {
  NEWAVE_GOLD_CASES,
  NEWAVE_GOLD_SUITE_VERSION
} from "../modules/agent-improvement/newave-gold-suite.js";
import { db } from "./client.js";
import { loadNewavePromptTemplate } from "./newave-template.js";

export const NEWAVE_OWNER_EMAIL = "arthurmuller07@gmail.com";
export const NEWAVE_TENANT_SLUG = "newave-ia";

// Commercial explanations in pt-BR routinely run 30-45 words in a single
// sentence (the prompt's own examples do). The shared default of 30 forces a
// mid-sentence split that fragments replies the prompt already asks to keep
// to 1-2 bubbles; only Newave's default is raised, Meta Cell keeps 30.
const NEWAVE_HUMANIZER_CONFIG = {
  ...DEFAULT_HUMANIZER_CONFIG,
  messageSplit: { ...DEFAULT_HUMANIZER_CONFIG.messageSplit, maxWordsPerBubble: 48 }
};

export async function provisionNewave(pool: Pool) {
  const prompt = await loadNewavePromptTemplate();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["provision:newave-ia"]);
    await ensurePermissionCatalog(client);

    const existingTenant = await client.query<{ id: string }>("SELECT id FROM tenants WHERE slug=$1", [NEWAVE_TENANT_SLUG]);
    const isNewWorkspace = !existingTenant.rows[0];
    const tenant = await client.query<{ id: string }>(
      `INSERT INTO tenants(name,slug,status,timezone)
       VALUES('Newave IA',$1,'active','America/Sao_Paulo')
       ON CONFLICT(slug) DO UPDATE SET
         name='Newave IA',status='active',updated_at=now()
       RETURNING id`,
      [NEWAVE_TENANT_SLUG]
    );
    const tenantId = tenant.rows[0].id;
    await ensureWorkspaceDefaultRoles(client, tenantId);

    const user = await client.query<{ id: string; status: "active" | "invited" | "disabled" }>(
      `INSERT INTO users(email,status,is_root)
       VALUES($1,'invited',false)
       ON CONFLICT(email) DO UPDATE SET updated_at=now()
       RETURNING id,status`,
      [NEWAVE_OWNER_EMAIL]
    );
    const ownerRole = await client.query<{ id: string }>(
      "SELECT id FROM workspace_roles WHERE workspace_id=$1 AND name='OWNER'",
      [tenantId]
    );
    const activeOwner = user.rows[0].status === "active";
    await client.query(
      `INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at)
       VALUES($1,$2,$3,$4,CASE WHEN $4='active' THEN now() ELSE NULL END)
       ON CONFLICT(workspace_id,user_id) DO UPDATE SET
         role_id=EXCLUDED.role_id,
         status=CASE WHEN workspace_members.status='active' THEN 'active' ELSE EXCLUDED.status END,
         joined_at=CASE WHEN workspace_members.status='active' OR EXCLUDED.status='active' THEN COALESCE(workspace_members.joined_at,now()) ELSE workspace_members.joined_at END,
         updated_at=now()`,
      [tenantId, user.rows[0].id, ownerRole.rows[0].id, activeOwner ? "active" : "invited"]
    );
    await client.query(
      "UPDATE tenants SET created_by_user_id=COALESCE(created_by_user_id,$2),updated_at=now() WHERE id=$1",
      [tenantId, user.rows[0].id]
    );

    const existingAgent = await client.query<{ id: string }>(
      "SELECT id FROM agent_configs WHERE tenant_id=$1 ORDER BY updated_at DESC,id LIMIT 1 FOR UPDATE",
      [tenantId]
    );
    let agentId = existingAgent.rows[0]?.id;
    if (agentId) {
      await client.query(
        "UPDATE agent_configs SET name='Representante Newave' WHERE id=$1",
        [agentId]
      );
    } else {
      const insertedAgent = await client.query<{ id: string }>(
        `INSERT INTO agent_configs(tenant_id,name,system_prompt,ai_model,model_params,enabled_tools,is_active)
         VALUES($1,'Representante Newave',$2,'openai/gpt-5.4-mini',$3,$4::jsonb,true)
         RETURNING id`,
        [tenantId, prompt, { temperature: 0.7, max_tokens: 1024, reasoning_effort: "medium" }, JSON.stringify(NEWAVE_ENABLED_TOOL_NAMES)]
      );
      agentId = insertedAgent.rows[0].id;
    }

    const session = await client.query<{ id: string }>(
      `INSERT INTO whatsapp_sessions(tenant_id)
       SELECT $1 WHERE NOT EXISTS (SELECT 1 FROM whatsapp_sessions WHERE tenant_id=$1)
       RETURNING id`,
      [tenantId]
    );
    const sessionId = session.rows[0]?.id ?? (await client.query<{ id: string }>(
      "SELECT id FROM whatsapp_sessions WHERE tenant_id=$1 ORDER BY created_at,id LIMIT 1",
      [tenantId]
    )).rows[0].id;

    await client.query(
      `INSERT INTO tenant_ai_settings(
         tenant_id,media_fallback_audio,media_fallback_image,media_fallback_document,humanizer_config,
         ai_follow_up_enabled,ai_follow_up_max_count,ai_follow_up_interval_minutes,ai_follow_up_delays_minutes
       )
       VALUES($1,$2,$3,$4,$5,true,3,120,ARRAY[120,1440,4320]::integer[])
       ON CONFLICT(tenant_id) DO UPDATE SET
         media_fallback_audio=COALESCE(tenant_ai_settings.media_fallback_audio,EXCLUDED.media_fallback_audio),
         media_fallback_image=COALESCE(tenant_ai_settings.media_fallback_image,EXCLUDED.media_fallback_image),
         media_fallback_document=COALESCE(tenant_ai_settings.media_fallback_document,EXCLUDED.media_fallback_document),
         humanizer_config=COALESCE(tenant_ai_settings.humanizer_config,EXCLUDED.humanizer_config),
         ai_follow_up_enabled=CASE WHEN $6 THEN EXCLUDED.ai_follow_up_enabled ELSE tenant_ai_settings.ai_follow_up_enabled END,
         ai_follow_up_max_count=CASE WHEN $6 THEN EXCLUDED.ai_follow_up_max_count ELSE tenant_ai_settings.ai_follow_up_max_count END,
         ai_follow_up_interval_minutes=CASE WHEN $6 THEN EXCLUDED.ai_follow_up_interval_minutes ELSE tenant_ai_settings.ai_follow_up_interval_minutes END,
         ai_follow_up_delays_minutes=CASE WHEN $6 THEN EXCLUDED.ai_follow_up_delays_minutes ELSE tenant_ai_settings.ai_follow_up_delays_minutes END,
         updated_at=now()`,
      [tenantId, DEFAULT_MEDIA_FALLBACK.audio, DEFAULT_MEDIA_FALLBACK.image, DEFAULT_MEDIA_FALLBACK.document, NEWAVE_HUMANIZER_CONFIG, isNewWorkspace]
    );

    await client.query(
      `INSERT INTO scheduling_units(tenant_id,id,name,opening_time,closing_time,operating_days,slot_duration_min,simultaneous_capacity)
       VALUES($1,'reunioes-comerciais','Reuniões comerciais','09:00','19:00',ARRAY[1,2,3,4,5]::smallint[],60,1)
       ON CONFLICT(tenant_id,id) DO UPDATE SET
         name=EXCLUDED.name,updated_at=now()`,
      [tenantId]
    );
    await client.query("UPDATE qualification_flows SET active=false,updated_at=now() WHERE tenant_id=$1 AND active", [tenantId]);

    for (const regressionCase of NEWAVE_GOLD_CASES) {
      const name = `${NEWAVE_GOLD_SUITE_VERSION}:${regressionCase.key}`;
      const updated = await client.query(
        `UPDATE ai_regression_cases
         SET description=$3,scenario=$4::jsonb,expected_behavior=$5::jsonb,
             severity=$6,is_active=true,updated_at=now()
         WHERE tenant_id=$1 AND name=$2
         RETURNING id`,
        [
          tenantId,
          name,
          regressionCase.description,
          regressionCase.scenario,
          regressionCase.expectedBehavior,
          regressionCase.severity
        ]
      );
      if (!updated.rows[0]) {
        await client.query(
          `INSERT INTO ai_regression_cases(
             tenant_id,name,description,scenario,expected_behavior,severity,created_by_user_id
           ) VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7)`,
          [
            tenantId,
            name,
            regressionCase.description,
            regressionCase.scenario,
            regressionCase.expectedBehavior,
            regressionCase.severity,
            user.rows[0].id
          ]
        );
      }
    }

    await client.query("COMMIT");
    return { tenantId, ownerUserId: user.rows[0].id, agentId, sessionId };
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
    const result = await provisionNewave(db);
    console.log(`Provisioned Newave IA tenant ${result.tenantId}, agent ${result.agentId}, session ${result.sessionId}`);
  } finally {
    await db.end();
  }
}
