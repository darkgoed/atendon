import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { appendFinancialLedgerEntry, listFinancialLedger } from "../src/billing/ledger.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const tenants: string[] = [];

async function tenant() {
  const id = (await pool.query<{ id: string }>(
    "INSERT INTO tenants(name,slug,status) VALUES($1,$2,'active') RETURNING id",
    [`ledger-${randomUUID()}`, `ledger-${randomUUID()}`],
  )).rows[0].id;
  tenants.push(id);
  return id;
}

async function concurrentCredits(tenantId: string, count: number, amountCents = 100) {
  const clients = await Promise.all(Array.from({ length: count }, () => pool.connect()));
  try {
    const append = (client: pg.PoolClient, index: number) => appendFinancialLedgerEntry(client, tenantId, {
      direction: "CREDIT", amountCents, actorType: "TEST", reason: `concurrent-${index}`,
      sourceEventId: `evt-${randomUUID()}`, correlationId: `corr-${randomUUID()}`,
    });
    return await Promise.all(clients.map(async (client, index) => {
      await client.query("BEGIN");
      const result = await append(client, index);
      await client.query("COMMIT");
      return result;
    }));
  } finally {
    clients.forEach(client => client.release());
  }
}

describe("financial ledger integration", () => {
  it("appends correlated entries with before/after balances and rejects mutation", async () => {
    const t = await tenant();
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      const first = await appendFinancialLedgerEntry(c, t, { direction: "CREDIT", amountCents: 100, actorType: "TEST", reason: "seed", sourceEventId: "evt-1", correlationId: "corr-1" });
      const second = await appendFinancialLedgerEntry(c, t, { direction: "CREDIT", amountCents: 25, actorType: "TEST", reason: "follow-up", sourceEventId: "evt-2", correlationId: "corr-2" });
      await c.query("COMMIT");
      expect(first).toMatchObject({ balance_before_cents: "0", balance_after_cents: "100", source_event_id: "evt-1", correlation_id: "corr-1" });
      expect(second).toMatchObject({ balance_before_cents: "100", balance_after_cents: "125" });
      const rows = await listFinancialLedger(pool as never, t);
      expect(rows).toHaveLength(2);
      await expect(pool.query("UPDATE financial_ledger SET reason='tampered' WHERE tenant_id=$1", [t])).rejects.toThrow(/append-only/);
      await expect(pool.query("DELETE FROM financial_ledger WHERE tenant_id=$1", [t])).rejects.toThrow(/append-only/);
    } finally { c.release(); }
  });

  it.each([2, 5])("serializes %i concurrent credits without losing a balance update", async count => {
    const t = await tenant();
    await concurrentCredits(t, count);
    const rows = (await pool.query<{ balance_before_cents: string; balance_after_cents: string; amount_cents: string; created_at: Date; id: string }>(
      "SELECT balance_before_cents, balance_after_cents, amount_cents, created_at, id FROM financial_ledger WHERE tenant_id=$1 ORDER BY created_at,id", [t])).rows;
    expect(rows).toHaveLength(count);
    expect(rows.reduce((sum, row) => sum + Number(row.amount_cents), 0)).toBe(count * 100);
    expect(Math.max(...rows.map(row => Number(row.balance_after_cents)))).toBe(count * 100);
    for (const row of rows) expect(Number(row.balance_after_cents)).toBe(Number(row.balance_before_cents) + Number(row.amount_cents));
    const chain = [...rows].sort((a, b) => Number(a.balance_after_cents) - Number(b.balance_after_cents));
    for (let i = 1; i < chain.length; i++) expect(chain[i].balance_before_cents).toBe(chain[i - 1].balance_after_cents);
  });

  it("rejects concurrent debits that would make the balance negative", async () => {
    const t = await tenant();
    await concurrentCredits(t, 1, 100);
    const clients = await Promise.all([pool.connect(), pool.connect()]);
    const results = await Promise.all(clients.map(async (client, index) => {
      await client.query("BEGIN");
      try {
        await appendFinancialLedgerEntry(client, t, { direction: "DEBIT", amountCents: 100, actorType: "TEST", reason: "debit", sourceEventId: `debit-${index}-${randomUUID()}`, correlationId: `corr-${randomUUID()}` });
        await client.query("COMMIT");
        return "ok";
      } catch (error) {
        await client.query("ROLLBACK");
        return (error as { code?: string }).code;
      } finally { client.release(); }
    }));
    expect(results).toContain("FINANCIAL_INSUFFICIENT_BALANCE");
    expect((await pool.query("SELECT balance_after_cents FROM financial_ledger WHERE tenant_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1", [t])).rows[0].balance_after_cents).toBe("0");
  });

  it("preserves idempotency for source event and correlation", async () => {
    const t = await tenant();
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      const input = { direction: "CREDIT" as const, amountCents: 75, actorType: "TEST", reason: "same", sourceEventId: "same-event", correlationId: "same-correlation" };
      const first = await appendFinancialLedgerEntry(c, t, input);
      const second = await appendFinancialLedgerEntry(c, t, input);
      await c.query("COMMIT");
      expect(first).not.toBeNull();
      expect(second).toBeNull();
    } finally { c.release(); }
    expect((await pool.query("SELECT count(*)::int AS count FROM financial_ledger WHERE tenant_id=$1", [t])).rows[0].count).toBe(1);
  });

  it("does not serialize different tenants behind one another", async () => {
    const firstTenant = await tenant();
    const secondTenant = await tenant();
    const blocker = await pool.connect();
    const other = await pool.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT pg_advisory_xact_lock(hashtext('financial_ledger:' || $1))", [firstTenant]);
      await other.query("BEGIN");
      const pendingFirst = appendFinancialLedgerEntry(blocker, firstTenant, { direction: "CREDIT", amountCents: 1, actorType: "TEST", reason: "blocked", sourceEventId: randomUUID(), correlationId: randomUUID() });
      const otherResult = await Promise.race([
        appendFinancialLedgerEntry(other, secondTenant, { direction: "CREDIT", amountCents: 1, actorType: "TEST", reason: "independent", sourceEventId: randomUUID(), correlationId: randomUUID() }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("different tenant serialized")), 1000)),
      ]);
      expect(otherResult).not.toBeNull();
      await other.query("COMMIT");
      await blocker.query("ROLLBACK");
      await pendingFirst.catch(() => undefined);
    } finally { blocker.release(); other.release(); }
  });
});

afterAll(async () => {
  if (tenants.length) await pool.query("DELETE FROM tenants WHERE id=ANY($1::uuid[])", [tenants]);
  await pool.end();
});
