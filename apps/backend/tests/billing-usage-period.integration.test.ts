import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { ensureOpenPeriod, updatePeriodLimitSnapshot } from "../src/billing/usage-period.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const tenants: string[] = [];
const plans: string[] = [];

async function createTenant(label: string): Promise<string> {
  const slug = `usage-period-${label}-${randomUUID()}`;
  const result = await pool.query<{ id: string }>(
    "INSERT INTO tenants(name,slug,status) VALUES($1,$2,'active') RETURNING id",
    [slug, slug]
  );
  tenants.push(result.rows[0].id);
  return result.rows[0].id;
}

async function createPlan(months = 1, limit: number | null = 10_000): Promise<string> {
  const code = `USAGE_PERIOD_${randomUUID()}`;
  const result = await pool.query<{ id: string }>(
    `INSERT INTO plans(code,name,billing_period_months,monthly_price_cents)
     VALUES($1,$2,$3,0) RETURNING id`,
    [code, code, months]
  );
  const id = result.rows[0].id;
  plans.push(id);
  await pool.query(
    "INSERT INTO plan_limits(plan_id,limit_key,limit_value) VALUES($1,'MAX_AI_INTERACTIONS',$2)",
    [id, limit]
  );
  return id;
}

async function subscribe(tenantId: string, planId: string): Promise<void> {
  await pool.query(
    `INSERT INTO tenant_subscriptions(tenant_id,plan_id,status,current_period_start,current_period_end)
     VALUES($1,$2,'ACTIVE',now(),now()+interval '12 months')`,
    [tenantId, planId]
  );
}

async function inTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const value = await fn(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function ensureWithSubscriptionLock(client: pg.PoolClient, tenantId: string) {
  await client.query("SELECT id FROM tenant_subscriptions WHERE tenant_id=$1 FOR UPDATE", [tenantId]);
  return ensureOpenPeriod(client, tenantId);
}

afterAll(async () => {
  if (tenants.length) await pool.query("DELETE FROM tenants WHERE id=ANY($1::uuid[])", [tenants]);
  if (plans.length) await pool.query("DELETE FROM plans WHERE id=ANY($1::uuid[])", [plans]);
  await pool.end();
});

describe("billing usage periods integration", () => {
  it("plano anual cria periodos mensais, nunca um balde anual", async () => {
    const tenantId = await createTenant("annual");
    const planId = await createPlan(12, 10_000);
    await subscribe(tenantId, planId);

    await inTransaction((client) => ensureWithSubscriptionLock(client, tenantId));
    for (let i = 0; i < 4; i++) {
      await pool.query(
        `UPDATE usage_periods SET start_at=now()-interval '3 months', end_at=now()-interval '2 months'
         WHERE tenant_id=$1 AND status='OPEN'`,
        [tenantId]
      );
      await inTransaction((client) => ensureWithSubscriptionLock(client, tenantId));
    }

    const result = await pool.query<{ included_limit: string; status: string; end_at: Date }>(
      "SELECT included_limit,status,end_at FROM usage_periods WHERE tenant_id=$1 ORDER BY start_at",
      [tenantId]
    );
    expect(result.rows.length).toBeGreaterThan(1);
    expect(result.rows.every((row) => Number(row.included_limit) === 10_000)).toBe(true);
    expect(result.rows.some((row) => Number(row.included_limit) === 120_000)).toBe(false);
    expect(result.rows.filter((row) => row.status === "OPEN" && row.end_at > new Date())).toHaveLength(1);
  });

  it("mantém exatamente um periodo OPEN sob concorrência real", async () => {
    const tenantId = await createTenant("concurrency");
    await subscribe(tenantId, await createPlan());
    const c1 = await pool.connect();
    const c2 = await pool.connect();
    try {
      // As duas transacoes abrem ANTES de qualquer ensure: sobreposicao real.
      await Promise.all([c1.query("BEGIN"), c2.query("BEGIN")]);
      // Cada conexao committa assim que TERMINA o proprio ensure. Se esperassemos
      // os dois ensures antes de committar, c2 ficaria travado no FOR UPDATE de c1
      // e o teste morreria de deadlock por construcao — sem testar nada.
      await Promise.all([
        ensureWithSubscriptionLock(c1, tenantId).then(() => c1.query("COMMIT")),
        ensureWithSubscriptionLock(c2, tenantId).then(() => c2.query("COMMIT")),
      ]);
    } finally {
      c1.release(); c2.release();
    }
    const result = await pool.query("SELECT id FROM usage_periods WHERE tenant_id=$1 AND status='OPEN'", [tenantId]);
    expect(result.rows).toHaveLength(1);
  }, 20000);

  it("nao duplica periodo quando duas transacoes correm SEM o lock de assinatura", async () => {
    // Este e o caso que exercita o caminho 23505 -> SAVEPOINT -> releitura.
    // Sem o FOR UPDATE nada serializa os dois INSERT, entao o indice unico parcial
    // dispara em uma das transacoes e o codigo precisa se recuperar DENTRO da
    // transacao (sem SAVEPOINT a transacao fica abortada com 25P02).
    const tenantId = await createTenant("race-no-lock");
    await subscribe(tenantId, await createPlan());
    const c1 = await pool.connect();
    const c2 = await pool.connect();
    const outcomes: string[] = [];
    try {
      await Promise.all([c1.query("BEGIN"), c2.query("BEGIN")]);
      await Promise.all([c1, c2].map(async (c) => {
        try {
          await ensureOpenPeriod(c, tenantId);
          await c.query("COMMIT");
          outcomes.push("ok");
        } catch (error) {
          await c.query("ROLLBACK").catch(() => undefined);
          outcomes.push(`fail:${(error as { code?: string }).code ?? (error as Error).message}`);
        }
      }));
    } finally {
      c1.release(); c2.release();
    }
    // Nenhuma transacao pode terminar com 25P02 (transacao abortada) — isso seria
    // exatamente a falha que o SAVEPOINT corrige.
    expect(outcomes.filter((o) => o.includes("25P02"))).toHaveLength(0);
    const open = await pool.query("SELECT id FROM usage_periods WHERE tenant_id=$1 AND status='OPEN'", [tenantId]);
    expect(open.rows).toHaveLength(1);
  }, 20000);

  it("tenant sem assinatura retorna null sem lançar", async () => {
    const tenantId = await createTenant("no-subscription");
    await expect(inTransaction((client) => ensureOpenPeriod(client, tenantId))).resolves.toBeNull();
  });

  it("updatePeriodLimitSnapshot altera o snapshot do periodo OPEN", async () => {
    const tenantId = await createTenant("override");
    await subscribe(tenantId, await createPlan());
    await inTransaction((client) => ensureWithSubscriptionLock(client, tenantId));
    await inTransaction(async (client) => updatePeriodLimitSnapshot(client, tenantId, 777));
    const result = await pool.query("SELECT included_limit FROM usage_periods WHERE tenant_id=$1 AND status='OPEN'", [tenantId]);
    expect(result.rows[0].included_limit).toBe("777");
  });

  it("é idempotente quando o periodo ainda está vigente", async () => {
    const tenantId = await createTenant("idempotency");
    await subscribe(tenantId, await createPlan());
    await inTransaction((client) => ensureWithSubscriptionLock(client, tenantId));
    const before = await pool.query("SELECT count(*)::int AS count FROM usage_periods WHERE tenant_id=$1", [tenantId]);
    await inTransaction((client) => ensureWithSubscriptionLock(client, tenantId));
    await inTransaction((client) => ensureWithSubscriptionLock(client, tenantId));
    const after = await pool.query("SELECT count(*)::int AS count FROM usage_periods WHERE tenant_id=$1", [tenantId]);
    expect(after.rows[0].count).toBe(before.rows[0].count);
  });
});
