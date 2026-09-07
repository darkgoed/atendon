import type { Pool, PoolClient } from "pg";

export type TransactionOptions = { isolationLevel?: "READ COMMITTED" | "REPEATABLE READ" | "SERIALIZABLE" };

export async function withTransaction<T>(
  pool: Pick<Pool, "connect">,
  work: (client: PoolClient) => Promise<T>,
  options: TransactionOptions = {}
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (options.isolationLevel) await client.query(`SET TRANSACTION ISOLATION LEVEL ${options.isolationLevel}`);
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* preserve original failure */ }
    throw error;
  } finally {
    client.release();
  }
}
