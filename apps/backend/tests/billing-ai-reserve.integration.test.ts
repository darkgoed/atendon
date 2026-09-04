import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { reserveAiInteraction } from "../src/billing/ai-metering.js";

/**
 * Achado ALTO da revisão da Fase 8: a checagem de franquia de IA acontecia fora
 * de transação e sem lock, então duas mensagens simultâneas do mesmo tenant
 * podiam ler o mesmo saldo e ambas passarem, estourando a franquia vendida.
 *
 * reserveAiInteraction resolve isso lendo o saldo e gravando o consumo na MESMA
 * transação, serializada por tenant com SELECT ... FOR UPDATE.
 */
const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const created: string[] = [];

async function tenantWithPlan(code: string, usedAlready = 0) {
  const suffix = randomUUID();
  const tenant = (await pool.query<{ id: string }>(
    "INSERT INTO tenants(name,slug,status) VALUES($1,$2,'active') RETURNING id",
    [`ai-reserve-${suffix}`, `ai-reserve-${suffix}`]
  )).rows[0].id;
  created.push(tenant);
  const start = new Date();
  await pool.query(
    `INSERT INTO tenant_subscriptions(tenant_id,plan_id,status,current_period_start,current_period_end)
     SELECT $1,id,'ACTIVE',$2,$3 FROM plans WHERE code=$4`,
    [tenant, start, new Date(start.getTime() + 86_400_000), code]
  );
  if (usedAlready > 0) {
    await pool.query(
      `INSERT INTO usage_counters(tenant_id,period_start,period_end,metric_key,used)
       VALUES($1,$2,$3,'MAX_AI_INTERACTIONS',$4)`,
      [tenant, start, new Date(start.getTime() + 86_400_000), usedAlready]
    );
  }
  return tenant;
}

async function counter(tenantId: string) {
  const result = await pool.query<{ used: string }>(
    "SELECT COALESCE(SUM(used),0) used FROM usage_counters WHERE tenant_id=$1 AND metric_key='MAX_AI_INTERACTIONS'",
    [tenantId]
  );
  return Number(result.rows[0].used);
}

afterAll(async () => {
  if (created.length) await pool.query("DELETE FROM tenants WHERE id=ANY($1::uuid[])", [created]);
  await pool.end();
});

describe("reserva atômica de interação de IA", () => {
  it("nega quando o plano não tem IA (BASIC, franquia 0)", async () => {
    const tenant = await tenantWithPlan("BASIC");
    expect(await reserveAiInteraction(tenant, "inbound_reply", randomUUID())).toBe(false);
    expect(await counter(tenant)).toBe(0);
  });

  it("permite dentro da franquia e contabiliza", async () => {
    const tenant = await tenantWithPlan("MEDIUM");
    expect(await reserveAiInteraction(tenant, "inbound_reply", randomUUID())).toBe(true);
    expect(await counter(tenant)).toBe(1);
  });

  it("é idempotente: mesmo turno lógico não consome duas vezes", async () => {
    const tenant = await tenantWithPlan("MEDIUM");
    const turn = randomUUID();
    expect(await reserveAiInteraction(tenant, "inbound_reply", turn)).toBe(true);
    expect(await reserveAiInteraction(tenant, "inbound_reply", turn)).toBe(true);
    expect(await counter(tenant)).toBe(1);
  });

  it("nega quando a franquia do período já foi consumida", async () => {
    // MEDIUM tem 10000; começa com 10000 já usados.
    const tenant = await tenantWithPlan("MEDIUM", 10_000);
    expect(await reserveAiInteraction(tenant, "inbound_reply", randomUUID())).toBe(false);
    expect(await counter(tenant)).toBe(10_000);
  });

  it("NÃO estoura a franquia sob concorrência real (achado ALTO da Fase 8)", async () => {
    // Uma única vaga restante e cinco turnos distintos disparados ao mesmo tempo.
    const tenant = await tenantWithPlan("MEDIUM", 9_999);
    const results = await Promise.all(
      Array.from({ length: 5 }, () => reserveAiInteraction(tenant, "inbound_reply", randomUUID()))
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results.filter((granted) => !granted)).toHaveLength(4);
    // O contador nunca passa do limite vendido.
    expect(await counter(tenant)).toBe(10_000);
  });

  it("fail-open: tenant sem assinatura nunca é bloqueado", async () => {
    const suffix = randomUUID();
    const tenant = (await pool.query<{ id: string }>(
      "INSERT INTO tenants(name,slug,status) VALUES($1,$2,'active') RETURNING id",
      [`ai-noplan-${suffix}`, `ai-noplan-${suffix}`]
    )).rows[0].id;
    created.push(tenant);
    expect(await reserveAiInteraction(tenant, "inbound_reply", randomUUID())).toBe(true);
  });
});
