import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { appendFinancialLedgerEntry, listFinancialLedger } from "../src/billing/ledger.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const tenants: string[] = [];

describe("financial ledger integration", () => {
  it("appends correlated entries with before/after balances and rejects mutation", async () => {
    const t = (await pool.query<{ id: string }>("INSERT INTO tenants(name,slug,status) VALUES($1,$2,'active') RETURNING id", [`ledger-${randomUUID()}`, `ledger-${randomUUID()}`])).rows[0].id;
    tenants.push(t);
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
});

afterAll(async () => { await pool.end(); });
