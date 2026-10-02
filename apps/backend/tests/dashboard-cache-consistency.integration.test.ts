import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import type { WorkspaceSession } from "../src/auth/session.js";
import {
  clearCommercialDashboardCacheForTests,
  commercialDashboardCacheKeysForTests,
  invalidateCommercialDashboardCache,
  loadCommercialDashboard,
  setCommercialDashboardCacheMaxEntriesForTests,
  setCommercialDashboardCacheOverrideForTests
} from "../src/modules/dashboard/service.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const suffix = randomUUID();
const leadSource = `cache-consistency-${suffix.slice(0, 8)}`;

let tenantA = "";
let tenantB = "";
let rootUserId = "";

function rootSession(tenantId: string, overrides: Partial<WorkspaceSession> = {}): WorkspaceSession {
  return {
    userId: rootUserId,
    tenantId,
    email: `cache-root-${suffix}@test.local`,
    isRoot: true,
    sessionVersion: 1,
    role: "ROOT",
    roleId: null,
    permissions: [],
    actorScope: "root",
    rootWorkspaceAccess: true,
    ...overrides
  };
}

async function countTestLeads(tenantId: string): Promise<number> {
  return (await pool.query<{ count: number }>(
    "SELECT count(*)::int count FROM scheduling_leads WHERE tenant_id=$1 AND source=$2",
    [tenantId, leadSource]
  )).rows[0].count;
}

async function insertTestLead(tenantId: string): Promise<void> {
  await pool.query(
    "INSERT INTO scheduling_leads(tenant_id, source, name, phone) VALUES($1,$2,$3,$4)",
    [tenantId, leadSource, `lead-${randomUUID().slice(0, 8)}`, `5511${Math.floor(10_0000_000 + Math.random() * 89_9999_999)}`]
  );
}

beforeAll(async () => {
  // Os caches ficam desligados fora de produção; estes hooks ligam o caminho
  // real de produção para exercitar chave, single-flight e invalidação.
  setCommercialDashboardCacheOverrideForTests(true);
  clearCommercialDashboardCacheForTests();
  tenantA = (await pool.query<{ id: string }>(
    "INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id",
    [`Cache A ${suffix}`]
  )).rows[0].id;
  tenantB = (await pool.query<{ id: string }>(
    "INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id",
    [`Cache B ${suffix}`]
  )).rows[0].id;
  rootUserId = (await pool.query<{ id: string }>(
    "INSERT INTO users(email,status,is_root) VALUES($1,'active',true) RETURNING id",
    [`cache-root-${suffix}@test.local`]
  )).rows[0].id;
  await insertTestLead(tenantA);
});

afterAll(async () => {
  clearCommercialDashboardCacheForTests();
  setCommercialDashboardCacheOverrideForTests(null);
  setCommercialDashboardCacheMaxEntriesForTests(300);
  await pool.query("DELETE FROM scheduling_leads WHERE tenant_id=ANY($1::uuid[]) AND source=$2", [[tenantA, tenantB], leadSource]);
  await pool.query("DELETE FROM users WHERE id=$1", [rootUserId]);
  await pool.query("DELETE FROM tenants WHERE id=ANY($1::uuid[])", [[tenantA, tenantB]]);
  await pool.end();
});

describe("cache do agregado comercial — consistência", () => {
  it("sinal realtime: mutação seguida de invalidação renova o agregado; sem invalidação, painel ficaria preso no valor velho", async () => {
    const input = { period: "today" as const };
    const before = await loadCommercialDashboard(rootSession(tenantA), input);
    expect(before.result.new_contacts).toBe(await countTestLeads(tenantA));

    await insertTestLead(tenantA);
    // Dentro do TTL a leitura volta cacheada — é exatamente o cenário em que o
    // painel revalida os widgets ao receber um sinal realtime e receberia o
    // agregado antigo.
    const cached = await loadCommercialDashboard(rootSession(tenantA), input);
    expect(cached.result.new_contacts).toBe(before.result.new_contacts);

    // O RealtimeCoordinator chama esta invalidação ao receber
    // conversation.messages.changed / appointment.changed /
    // case.assignment.changed / alerts.changed do tenant.
    invalidateCommercialDashboardCache(tenantA);
    const fresh = await loadCommercialDashboard(rootSession(tenantA), input);
    expect(fresh.result.new_contacts).toBe(before.result.new_contacts + 1);
    expect(fresh).not.toBe(cached);
  });

  it("chave isola tenant, usuário, papel e período", async () => {
    clearCommercialDashboardCacheForTests();
    await insertTestLead(tenantB);
    const tenantBOnly = await loadCommercialDashboard(rootSession(tenantB), { period: "today" });
    expect(tenantBOnly.result.new_contacts).toBe(1);
    expect(tenantBOnly.result.new_contacts).toBe(await countTestLeads(tenantB));

    await loadCommercialDashboard(rootSession(tenantA), { period: "today" });
    await loadCommercialDashboard(rootSession(tenantA, { role: "ATTENDANT", isRoot: false, actorScope: "workspace" }), { period: "today" });
    await loadCommercialDashboard(rootSession(tenantA), { period: "week" });
    const keys = commercialDashboardCacheKeysForTests();
    expect(keys.length).toBe(4);
    expect(new Set(keys.map((key) => key.split("|")[0]))).toEqual(new Set([tenantA, tenantB]));
    // papel e período fazem parte da chave: mesma (tenant, usuário) com papel
    // ou período diferentes nunca compartilha entrada.
    const tenantAKeys = keys.filter((key) => key.startsWith(`${tenantA}|`));
    expect(tenantAKeys.length).toBe(3);
    expect(new Set(tenantAKeys.map((key) => key.split("|")[3]))).toEqual(new Set(["ROOT", "ATTENDANT"]));
    expect(new Set(tenantAKeys.map((key) => key.split("|")[4]))).toEqual(new Set(["today", "week"]));
  });

  it("promise rejeitada não fica presa no single-flight", async () => {
    clearCommercialDashboardCacheForTests();
    const badSession = rootSession("not-a-uuid");
    await expect(loadCommercialDashboard(badSession, { period: "today" })).rejects.toBeTruthy();
    // entrada rejeitada foi evictada: nova tentativa re-executa (e falha de
    // novo, sem herdar a promise antiga); chave válida continua funcionando.
    expect(commercialDashboardCacheKeysForTests().some((key) => key.includes("not-a-uuid"))).toBe(false);
    await expect(loadCommercialDashboard(badSession, { period: "today" })).rejects.toBeTruthy();
    const ok = await loadCommercialDashboard(rootSession(tenantA), { period: "today" });
    expect(ok.scope.type).toBe("workspace");
  });

  it("cap de entradas evicta a mais antiga (crescimento limitado)", async () => {
    clearCommercialDashboardCacheForTests();
    setCommercialDashboardCacheMaxEntriesForTests(3);
    for (const period of ["today", "week", "month"] as const) {
      await loadCommercialDashboard(rootSession(tenantA), { period });
    }
    expect(commercialDashboardCacheKeysForTests().length).toBe(3);
    await loadCommercialDashboard(rootSession(tenantA), { period: "today", start: "2026-01-01", end: "2026-01-31" });
    const keys = commercialDashboardCacheKeysForTests();
    expect(keys.length).toBe(3);
    expect(keys.some((key) => key.endsWith("|2026-01-01|2026-01-31|"))).toBe(true);
  });
});
