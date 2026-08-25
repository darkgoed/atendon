import type { Pool, PoolClient } from "pg";
import { z } from "zod";

const tenantIdSchema = z.string().uuid();

export function validatedTenantId(value: string): string {
  return tenantIdSchema.parse(value);
}

async function setLocalTenantContext(client: PoolClient, tenantId: string): Promise<void> {
  // tenantId is parsed as a UUID before interpolation. PostgreSQL does not
  // accept bind parameters in SET LOCAL, so this remains both injectable-safe
  // and visibly scoped to the current transaction.
  await client.query(`SET LOCAL app.tenant_id = '${validatedTenantId(tenantId)}'`);
}

export async function withTenantTransaction<T>(
  pool: Pick<Pool, "connect">,
  tenantId: string,
  work: (client: PoolClient) => Promise<T>
): Promise<T> {
  const validated = validatedTenantId(tenantId);
  const client = await pool.connect();
  let transactionStarted = false;
  try {
    await client.query("BEGIN");
    transactionStarted = true;
    await setLocalTenantContext(client, validated);
    const result = await work(client);
    await client.query("COMMIT");
    transactionStarted = false;
    return result;
  } catch (error) {
    if (transactionStarted) await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
