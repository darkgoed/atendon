import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { authorizeTripzAiWorkerScope, createTripzFeatureGate } from "../src/modules/tripz-ai/authorization.js";

function capabilityDatabase(options: {
  supported?: boolean;
  enabled?: boolean;
  killSwitchEnabled?: boolean;
  tenantStatus?: string;
  actor?: { is_root: boolean; status: string; can_use: boolean; can_manage: boolean };
} = {}) {
  const query = vi.fn(async (statement: string) => {
    if (statement.startsWith("SELECT status FROM tenants")) {
      return { rows: [{ status: options.tenantStatus ?? "active" }] };
    }
    if (statement.includes("FROM feature_flag_definitions d")) {
      return { rows: [{
        flag_key: "tripz_ai_v1",
        description: "Tripz IA",
        display_name: "Tripz IA",
        kind: "capability",
        tenant_configurable: true,
        availability_mode: "supported_tenants",
        ui_order: 60,
        default_enabled: false,
        global_enabled: null,
        kill_switch_enabled: options.killSwitchEnabled ?? false,
        tenant_override: options.enabled === false ? false : true,
        supported: options.supported ?? true,
        updated_at: new Date().toISOString()
      }] };
    }
    if (statement.includes("FROM capability_dependencies")) return { rows: [] };
    if (statement.includes("FROM users actor")) return { rows: options.actor ? [options.actor] : [] };
    throw new Error(`Consulta inesperada no teste: ${statement}`);
  });
  return { query };
}

describe("Tripz AI worker authorization", () => {
  it("rechecks the feature kill switch before membership", async () => {
    const database = capabilityDatabase({ killSwitchEnabled: true });
    await expect(authorizeTripzAiWorkerScope(database as never, {
      tenantId: randomUUID(), userId: randomUUID(), canManage: true
    })).rejects.toMatchObject({ code: "FEATURE_FLAG_DISABLED", statusCode: 409 });
    expect(database.query.mock.calls.some(([statement]) => String(statement).includes("FROM users actor"))).toBe(false);
  });

  it("derives current manage access instead of trusting the serialized job scope", async () => {
    const tenantId = randomUUID();
    const userId = randomUUID();
    const database = capabilityDatabase({
      actor: { is_root: false, status: "active", can_use: true, can_manage: false }
    });
    await expect(authorizeTripzAiWorkerScope(database as never, {
      tenantId, userId, canManage: true
    })).resolves.toEqual({ tenantId, userId, canManage: false });
  });

  it("denies a revoked membership even if the queued scope previously had manage access", async () => {
    const database = capabilityDatabase({
      actor: { is_root: false, status: "active", can_use: false, can_manage: false }
    });
    await expect(authorizeTripzAiWorkerScope(database as never, {
      tenantId: randomUUID(), userId: randomUUID(), canManage: true
    })).rejects.toMatchObject({ code: "TRIPZ_PERMISSION_DENIED", statusCode: 403 });
  });

  it("refuses a tenant without explicit Tripz support even if an override is enabled", async () => {
    const database = capabilityDatabase({ supported: false });
    await expect(createTripzFeatureGate(database as never)(randomUUID()))
      .rejects.toMatchObject({ code: "FEATURE_FLAG_DISABLED", statusCode: 409 });
  });

  it("refuses a suspended Tripz tenant before worker authorization", async () => {
    const database = capabilityDatabase({ tenantStatus: "suspended" });
    await expect(createTripzFeatureGate(database as never)(randomUUID()))
      .rejects.toMatchObject({ code: "FEATURE_FLAG_DISABLED", statusCode: 409 });
    expect(database.query).toHaveBeenCalledTimes(1);
  });
});
