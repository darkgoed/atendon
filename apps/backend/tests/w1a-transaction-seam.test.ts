import type { Pool, PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { withTenantTransaction } from "../src/db/tenant-transaction.js";

const tenantId = "11111111-1111-4111-8111-111111111111";

function mockedPool(queryImpl?: (sql: string) => Promise<unknown>) {
  const query = vi.fn((sql: string) => queryImpl?.(sql) ?? Promise.resolve({ rows: [] }));
  const release = vi.fn();
  const client = { query, release } as unknown as PoolClient;
  const pool = { connect: vi.fn().mockResolvedValue(client) } as unknown as Pick<Pool, "connect">;
  return { pool, query, release };
}

describe("transaction seam characterization", () => {
  it("commits after successful work", async () => {
    const { pool, query, release } = mockedPool();
    await withTenantTransaction(pool, tenantId, async (client) => { await client.query("SELECT 1"); });
    expect(query.mock.calls.map(([sql]) => sql)).toEqual(["BEGIN", `SET LOCAL app.tenant_id = '${tenantId}'`, "SELECT 1", "COMMIT"]);
    expect(release).toHaveBeenCalledOnce();
  });

  it("rolls back and rethrows the original work exception", async () => {
    const { pool, query, release } = mockedPool();
    const original = new Error("original work failure");
    await expect(withTenantTransaction(pool, tenantId, async () => { throw original; })).rejects.toBe(original);
    expect(query.mock.calls.map(([sql]) => sql)).toEqual(["BEGIN", `SET LOCAL app.tenant_id = '${tenantId}'`, "ROLLBACK"]);
    expect(release).toHaveBeenCalledOnce();
  });

  it("releases the client even when rollback fails", async () => {
    const rollbackFailure = new Error("rollback failure");
    const { pool, release } = mockedPool(async (sql) => {
      if (sql === "ROLLBACK") throw rollbackFailure;
      return { rows: [] };
    });
    const original = new Error("work failure");
    await expect(withTenantTransaction(pool, tenantId, async () => { throw original; })).rejects.toBe(original);
    expect(release).toHaveBeenCalledOnce();
  });
});
