import { describe, expect, it } from "vitest";
import { provisionTripzZulu } from "../src/db/provision-tripz.js";
import { TRIPZ_ZULU_SYSTEM_PROMPT } from "../src/modules/tripz-ai/zulu.js";

function fakePool(responses: Array<{ rows?: unknown[]; rowCount?: number }> | ((sql: string) => { rows?: unknown[]; rowCount?: number })): {
  calls: string[];
  pool: { connect: () => Promise<{ query: (sql: string) => Promise<{ rows?: unknown[]; rowCount?: number }>; release: () => void }> };
} {
  const calls: string[] = [];
  const client = {
    query: async (sql: string) => {
      calls.push(sql);
      return typeof responses === "function" ? responses(sql) : responses.shift() ?? { rows: [] };
    },
    release: () => undefined
  };
  return { calls, pool: { connect: async () => client } };
}

describe("Tripz Zulu deploy publisher", () => {
  it("publishes one immutable active version and is idempotent", async () => {
    const first = fakePool([
      {}, {}, { rows: [{ id: "tenant-1" }] },
      { rows: [{ id: "agent-1", active_version_id: null, system_prompt: "old", ai_model: "old-model", model_params: {}, enabled_tools: [], active_version_prompt: null, active_version_tools: null }] },
      { rowCount: 1 }, { rows: [{ enabled: false }] }, { rowCount: 2 }, { rowCount: 2 },
      { rows: [{ version_number: 4 }] }, {}, { rows: [{ id: "version-5" }] }, {}, {}
    ]);
    await expect(provisionTripzZulu(first.pool as unknown as Parameters<typeof provisionTripzZulu>[0], "tripz-test")).resolves.toMatchObject({
      tenantId: "tenant-1", agentId: "agent-1", changed: true, promptChanged: true, featureEnabled: false
    });
    expect(first.calls.some((sql) => sql.includes("INSERT INTO agent_config_versions"))).toBe(true);
    expect(first.calls.some((sql) => sql.includes("UPDATE agent_configs SET system_prompt"))).toBe(true);
    expect(first.calls.some((sql) => sql.includes("LEFT JOIN agent_config_versions") && sql.includes("FOR UPDATE OF agent"))).toBe(true);

    const second = fakePool([
      {}, {}, { rows: [{ id: "tenant-1" }] },
      { rows: [{ id: "agent-1", active_version_id: "version-5", system_prompt: TRIPZ_ZULU_SYSTEM_PROMPT, ai_model: "old-model", model_params: {}, enabled_tools: ["registrar_lead", "atualizar_status_lead"], active_version_prompt: TRIPZ_ZULU_SYSTEM_PROMPT, active_version_tools: ["registrar_lead", "atualizar_status_lead"] }] },
      { rowCount: 0 }, { rows: [{ enabled: false }] }, { rowCount: 0 }, { rowCount: 0 },
      {}
    ]);
    await expect(provisionTripzZulu(second.pool as unknown as Parameters<typeof provisionTripzZulu>[0], "tripz-test")).resolves.toMatchObject({
      tenantId: "tenant-1", agentId: "agent-1", changed: false, promptChanged: false, featureEnabled: false, reason: "already_current"
    });
    expect(second.calls.some((sql) => sql.includes("INSERT INTO agent_config_versions"))).toBe(false);
    expect(first.calls.filter((sql) => sql.includes("INSERT INTO tenant_feature_flag_overrides")).length).toBe(0);
    expect(first.calls.some((sql) => sql.includes("INSERT INTO tenant_capability_support"))).toBe(true);
    expect(first.calls.filter((sql) => sql.includes("workspace_role_permissions")).length).toBe(2);
  });

  it("rolls back without enabling the feature when no active agent exists", async () => {
    const target = fakePool([
      {}, {}, { rows: [{ id: "tenant-1" }] }, { rows: [] }, {}
    ]);
    await expect(provisionTripzZulu(target.pool as unknown as Parameters<typeof provisionTripzZulu>[0], "tripz-test"))
      .resolves.toMatchObject({
        tenantId: "tenant-1",
        agentId: null,
        changed: false,
        featureEnabled: false,
        reason: "agent_not_found"
      });
    expect(target.calls.at(-1)).toBe("ROLLBACK");
    expect(target.calls.some((sql) => sql.includes("INSERT INTO tenant_feature_flag_overrides"))).toBe(false);
  });

  it("publishes a new version when the denormalized prompt hides a stale active version", async () => {
    const target = fakePool([
      {}, {}, { rows: [{ id: "tenant-1" }] },
      { rows: [{ id: "agent-1", active_version_id: "version-old", system_prompt: TRIPZ_ZULU_SYSTEM_PROMPT, ai_model: "old-model", model_params: {}, enabled_tools: ["registrar_lead"], active_version_prompt: "stale", active_version_tools: [] }] },
      { rowCount: 0 }, { rows: [{ enabled: false }] }, { rowCount: 0 }, { rowCount: 0 },
      { rows: [{ version_number: 6 }] }, {}, { rows: [{ id: "version-6" }] }, {}, {}
    ]);
    await expect(provisionTripzZulu(target.pool as unknown as Parameters<typeof provisionTripzZulu>[0], "tripz-test"))
      .resolves.toMatchObject({ changed: true, promptChanged: true });
    expect(target.calls.some((sql) => sql.includes("INSERT INTO agent_config_versions"))).toBe(true);
    expect(target.calls.some((sql) => sql.includes("enabled_tools=$5::jsonb"))).toBe(true);
  });
});
