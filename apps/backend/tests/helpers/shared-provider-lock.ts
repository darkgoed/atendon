// Suítes que apagam/recriam a linha GLOBAL billing_providers(mercadopago, *)
// não podem rodar em paralelo entre workers do vitest: uma apaga a linha que a
// outra está usando (FK em invoices/billing_events) ou vê pagamentos da outra.
// Advisory lock de sessão numa conexão dedicada, segurado do beforeAll ao
// afterAll, serializa só essas suítes; as demais seguem paralelas.
import pg from "pg";
import { config } from "../../src/config.js";

const LOCK_KEY = 7_202_609_261; // arbitrário e exclusivo desta finalidade
export const SHARED_PROVIDER_LOCK_TIMEOUT_MS = 600_000;

/** Chave própria para suítes que varrem o estado GLOBAL do Instagram (tokens vencidos, tenants ativos). */
export const INSTAGRAM_GLOBAL_LOCK_KEY = 7_202_609_262;

export async function acquireSharedProviderLock(key = LOCK_KEY): Promise<() => Promise<void>> {
  const client = new pg.Client({ connectionString: config.DATABASE_URL });
  await client.connect();
  await client.query("SELECT pg_advisory_lock($1)", [key]);
  return async () => {
    try { await client.query("SELECT pg_advisory_unlock($1)", [key]); } finally { await client.end(); }
  };
}
