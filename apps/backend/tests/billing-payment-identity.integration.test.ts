import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { config } from "../src/config.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const suffix = randomUUID();
const providerIds: string[] = [];
let tenantId: string;
let invoiceId: string;

async function payment(providerId: string, externalId: string | null) {
  return pool.query(
    `INSERT INTO payments(tenant_id,invoice_id,provider_id,external_id,amount_cents,currency,status)
     VALUES($1,$2,$3,$4,100,'BRL','pending') RETURNING id`,
    [tenantId, invoiceId, providerId, externalId]
  );
}

async function seed() {
  tenantId = (await pool.query<{ id: string }>(
    "INSERT INTO tenants(name,slug,status) VALUES($1,$2,'active') RETURNING id",
    [`Payment identity ${suffix}`, `payment-identity-${suffix}`]
  )).rows[0].id;
  const providers = await pool.query<{ id: string }>(
    "INSERT INTO billing_providers(code,name,environment) VALUES($1,'Identity test','sandbox'),($2,'Identity test 2','sandbox') RETURNING id",
    [`identity-${suffix}`, `identity-2-${suffix}`]
  );
  providerIds.push(...providers.rows.map((row) => row.id));
  invoiceId = (await pool.query<{ id: string }>(
    `INSERT INTO invoices(tenant_id,provider_id,external_id,kind,amount_cents,currency,status,due_date)
     VALUES($1,$2,$3,'subscription',100,'BRL','open',now()) RETURNING id`,
    [tenantId, providerIds[0], `invoice-${suffix}`]
  )).rows[0].id;
}

afterAll(async () => {
  await pool.query("DELETE FROM payments WHERE tenant_id=$1", [tenantId]);
  await pool.query("DELETE FROM invoices WHERE id=$1", [invoiceId]);
  await pool.query("DELETE FROM billing_providers WHERE id=ANY($1::uuid[])", [providerIds]);
  await pool.query("DELETE FROM tenants WHERE id=$1", [tenantId]);
  await pool.end();
});

describe("payment provider identity constraint", () => {
  it("enforces provider identity, allows cross-provider and manual payments, and exposes the required index", async () => {
    await seed();
    const index = await pool.query<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE tablename='payments' AND indexname='uq_payments_provider_external_id'"
    );
    expect(index.rows).toHaveLength(1);
    await payment(providerIds[0], "same-payment-id");
    await expect(payment(providerIds[0], "same-payment-id")).rejects.toMatchObject({ code: "23505" });
    await expect(payment(providerIds[1], "same-payment-id")).resolves.toBeTruthy();
    await expect(payment(providerIds[0], null)).resolves.toBeTruthy();
    await expect(payment(providerIds[0], null)).resolves.toBeTruthy();
  });

  it("serializes concurrent inserts so exactly one transaction commits without deadlock", async () => {
    const clients = [new pg.Client({ connectionString: config.DATABASE_URL }), new pg.Client({ connectionString: config.DATABASE_URL })];
    await Promise.all(clients.map((client) => client.connect()));
    const key = `concurrent-${suffix}`;
    try {
      await Promise.all(clients.map((client) => client.query("BEGIN")));
      const insertSql = `INSERT INTO payments(tenant_id,invoice_id,provider_id,external_id,amount_cents,currency,status)
         VALUES($1,$2,$3,$4,100,'BRL','pending')`;
      await clients[0].query(insertSql, [tenantId, invoiceId, providerIds[0], key]);
      const losingInsert = clients[1].query(insertSql, [tenantId, invoiceId, providerIds[0], key])
        .then(() => ({ ok: true as const }), (error: unknown) => ({ ok: false as const, error }));
      await clients[0].query("COMMIT");
      const losingResult = await losingInsert;
      expect(losingResult.ok).toBe(false);
      expect(!losingResult.ok && (losingResult.error as { code?: string }).code).toBe("23505");
      await clients[1].query("ROLLBACK");
      const count = await pool.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM payments WHERE provider_id=$1 AND external_id=$2",
        [providerIds[0], key]
      );
      expect(count.rows[0].count).toBe(1);
    } finally {
      await Promise.all(clients.map((client) => client.end()));
    }
  }, 15_000);
});
