import type { Pool, PoolClient } from "pg";
import { withTransaction } from "./transaction.js";
import { z } from "zod";

const tenantIdSchema = z.string().uuid();
export function validatedTenantId(value: string): string { return tenantIdSchema.parse(value); }
async function setLocalTenantContext(client: PoolClient, tenantId: string): Promise<void> {
  await client.query(`SET LOCAL app.tenant_id = '${validatedTenantId(tenantId)}'`);
}
export async function withTenantTransaction<T>(pool: Pick<Pool, "connect">, tenantId: string, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const validated = validatedTenantId(tenantId);
  return withTransaction(pool, async (client) => {
    await setLocalTenantContext(client, validated);
    return work(client);
  });
}
