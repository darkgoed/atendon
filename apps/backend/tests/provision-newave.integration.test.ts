import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { NEWAVE_OWNER_EMAIL, NEWAVE_TENANT_SLUG, provisionNewave } from "../src/db/provision-newave.js";
import { NEWAVE_ENABLED_TOOL_NAMES } from "../src/modules/ai-router/tools.js";
import { publishManualVersion, rollbackToVersion } from "../src/modules/agent-improvement/versions.js";
import { NEWAVE_GOLD_CASES, NEWAVE_GOLD_SUITE_VERSION } from "../src/modules/agent-improvement/newave-gold-suite.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
let tenantId = "";

afterAll(async () => {
  if (tenantId) await pool.query("DELETE FROM tenants WHERE id=$1", [tenantId]);
  await pool.query(
    "DELETE FROM audit_logs WHERE actor_user_id=(SELECT id FROM users WHERE email=$1)",
    [NEWAVE_OWNER_EMAIL]
  );
  await pool.query(
    "DELETE FROM users WHERE email=$1 AND password_hash IS NULL AND NOT EXISTS (SELECT 1 FROM workspace_members WHERE user_id=users.id)",
    [NEWAVE_OWNER_EMAIL]
  );
  await pool.end();
});

describe("Newave provisioning", () => {
  it("is idempotent and preserves the Meta Cell configuration", async () => {
    const meta = await pool.query<{ id: string }>("INSERT INTO tenants(name,status) VALUES('Meta Cell IA','active') RETURNING id");
    await pool.query(
      "INSERT INTO agent_configs(tenant_id,system_prompt,ai_model) VALUES($1,'PROMPT META INALTERADO','openai/gpt-5-mini')",
      [meta.rows[0].id]
    );
    try {
      const first = await provisionNewave(pool);
      tenantId = first.tenantId;
      const initialAgent = await pool.query("SELECT system_prompt,ai_model FROM agent_configs WHERE tenant_id=$1", [tenantId]);
      expect(initialAgent.rows[0].ai_model).toBe("openai/gpt-5.4-mini");
      expect(initialAgent.rows[0].system_prompt).toContain("você é o assistente digital da Newave Pay");
      expect(initialAgent.rows[0].system_prompt).toContain("não houver pergunta direta de identidade, não revele espontaneamente");
      expect(initialAgent.rows[0].system_prompt).toContain("Todo lead, de 1 a 5 estrelas, segue para tentativa de agendamento");

      const owner = await pool.query<{ id: string }>("SELECT id FROM users WHERE email=$1", [NEWAVE_OWNER_EMAIL]);
      const client = await pool.connect();
      let activeVersionId!: string;
      try {
        await client.query("BEGIN");
        const version = await publishManualVersion(client, {
          tenantId,
          systemPrompt: "PROMPT ATIVO CONFIGURADO NO PAINEL",
          aiModel: "openai/gpt-5.4-mini",
          modelParams: { temperature: 0.2, max_tokens: 2048, reasoning_effort: "high" },
          enabledTools: [...NEWAVE_ENABLED_TOOL_NAMES],
          isActive: true,
          userId: owner.rows[0].id,
          actorScope: "workspace"
        });
        const rollback = await rollbackToVersion(client, {
          tenantId,
          sourceVersionId: version.id,
          reason: "Preparação explícita de configuração ativa legada para o teste",
          userId: owner.rows[0].id,
          actorScope: "workspace"
        });
        activeVersionId = rollback.id;
        await client.query(
          `UPDATE scheduling_units SET closing_time='19:00',slot_duration_min=45,simultaneous_capacity=2
           WHERE tenant_id=$1 AND id='reunioes-comerciais'`,
          [tenantId]
        );
        await client.query("COMMIT");
      } finally {
        client.release();
      }

      const second = await provisionNewave(pool);
      expect(second).toEqual(first);

      const result = await pool.query(
        `SELECT t.name,t.slug,t.timezone,
          (SELECT count(*)::int FROM whatsapp_sessions WHERE tenant_id=t.id) sessions,
          (SELECT count(*)::int FROM agent_configs WHERE tenant_id=t.id) agents,
          (SELECT count(*)::int FROM scheduling_units WHERE tenant_id=t.id AND id='reunioes-comerciais'
             AND opening_time='09:00' AND closing_time='19:00' AND operating_days=ARRAY[1,2,3,4,5]::smallint[]
             AND slot_duration_min=45 AND simultaneous_capacity=2) agendas
         FROM tenants t WHERE t.id=$1`,
        [tenantId]
      );
      expect(result.rows[0]).toEqual({
        name: "Newave IA", slug: NEWAVE_TENANT_SLUG, timezone: "America/Sao_Paulo", sessions: 1, agents: 1, agendas: 1
      });

      const agent = await pool.query("SELECT active_version_id,system_prompt,ai_model,model_params,enabled_tools FROM agent_configs WHERE tenant_id=$1", [tenantId]);
      expect(agent.rows[0]).toMatchObject({
        active_version_id: activeVersionId,
        system_prompt: "PROMPT ATIVO CONFIGURADO NO PAINEL",
        ai_model: "openai/gpt-5.4-mini",
        model_params: expect.objectContaining({ temperature: 0.2, reasoning_effort: "high" }),
        enabled_tools: [...NEWAVE_ENABLED_TOOL_NAMES]
      });

      const followUps = await pool.query(
        "SELECT ai_follow_up_enabled,ai_follow_up_max_count,ai_follow_up_delays_minutes FROM tenant_ai_settings WHERE tenant_id=$1",
        [tenantId]
      );
      expect(followUps.rows[0]).toEqual({
        ai_follow_up_enabled: true,
        ai_follow_up_max_count: 3,
        ai_follow_up_delays_minutes: [120, 1440, 4320]
      });
      const goldCases = await pool.query<{ count: number }>(
        `SELECT count(*)::int count FROM ai_regression_cases
         WHERE tenant_id=$1 AND name LIKE $2 AND is_active`,
        [tenantId, `${NEWAVE_GOLD_SUITE_VERSION}:%`]
      );
      expect(goldCases.rows[0].count).toBe(NEWAVE_GOLD_CASES.length);

      const ownerMembership = await pool.query(
        `SELECT r.name FROM workspace_members m
         JOIN users u ON u.id=m.user_id
         JOIN workspace_roles r ON r.id=m.role_id
         WHERE m.workspace_id=$1 AND u.email=$2`,
        [tenantId, NEWAVE_OWNER_EMAIL]
      );
      expect(ownerMembership.rows[0]?.name).toBe("OWNER");
      expect((await pool.query("SELECT system_prompt FROM agent_configs WHERE tenant_id=$1", [meta.rows[0].id])).rows[0].system_prompt)
        .toBe("PROMPT META INALTERADO");
    } finally {
      await pool.query("DELETE FROM tenants WHERE id=$1", [meta.rows[0].id]);
    }
  });
});
