import type { Pool, PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { withTenantTransaction } from "../src/db/tenant-transaction.js";

const tenantId = "11111111-1111-4111-8111-111111111111";

function mockedPool() {
  const query = vi.fn().mockResolvedValue({ rows: [] });
  const release = vi.fn();
  const client = { query, release } as unknown as PoolClient;
  const connect = vi.fn().mockResolvedValue(client);
  const pool = { connect } as unknown as Pick<Pool, "connect">;
  return { pool, connect, query, release, client };
}

describe("tenant-scoped database transactions", () => {
  it("sets a validated local tenant context and commits before releasing", async () => {
    const { pool, query, release } = mockedPool();

    await expect(withTenantTransaction(pool, tenantId, async (client) => {
      expect(client).toBeDefined();
      await client.query("SELECT 1");
      return "ok";
    })).resolves.toBe("ok");

    expect(query.mock.calls.map(([sql]) => sql)).toEqual([
      "BEGIN",
      `SET LOCAL app.tenant_id = '${tenantId}'`,
      "SELECT 1",
      "COMMIT"
    ]);
    expect(release).toHaveBeenCalledOnce();
  });

  it("rolls back and releases when tenant work fails", async () => {
    const { pool, query, release } = mockedPool();

    await expect(withTenantTransaction(pool, tenantId, async () => {
      throw new Error("work failed");
    })).rejects.toThrow("work failed");

    expect(query.mock.calls.map(([sql]) => sql)).toEqual([
      "BEGIN",
      `SET LOCAL app.tenant_id = '${tenantId}'`,
      "ROLLBACK"
    ]);
    expect(release).toHaveBeenCalledOnce();
  });

  it("rejects malformed tenant IDs before acquiring a pooled connection", async () => {
    const { pool, connect } = mockedPool();

    await expect(withTenantTransaction(
      pool,
      "11111111-1111-4111-8111-111111111111'; RESET ROLE; --",
      async () => undefined
    )).rejects.toThrow();

    expect(connect).not.toHaveBeenCalled();
  });
});
