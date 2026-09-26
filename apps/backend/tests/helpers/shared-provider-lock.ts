// Suítes que apagam/recriam a linha GLOBAL billing_providers(mercadopago, *)
// não podem rodar em paralelo entre workers do vitest: uma apaga a linha que a
// outra está usando (FK em invoices/billing_events) ou vê pagamentos da outra.
// Advisory lock de sessão numa conexão dedicada, segurado do beforeAll ao
// afterAll, serializa só essas suítes; as demais seguem paralelas.
import pg from "pg";
import { config } from "../../src/config.js";

const LOCK_KEY = 7_202_609_261; // arbitrário e exclusivo desta finalidade
export const SHARED_PROVIDER_LOCK_TIMEOUT_MS = 600_000;

export async function acquireSharedProviderLock(): Promise<() => Promise<void>> {
  const client = new pg.Client({ connectionString: config.DATABASE_URL });
  await client.connect();
  await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
  return async () => {
    try { await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]); } finally { await client.end(); }
  };
}
