import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { decryptCredentials } from "../src/billing/providers/credentials.js";
import { disconnect, getProvider, listProviders, markValidationFailure, markValidationSuccess, saveEncryptedCredentials, updateCommercialConfig } from "../src/billing/providers/store.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const code = `r15-${randomUUID()}`;
const actor = randomUUID();
const forbidden = ["credentials_encrypted", "webhook_secret", "token", "clientSecret", "accessToken", "refreshToken"];
const leakedPlaintext = "R15-PLAINTEXT-SECRET";
let providerIds: string[] = [];

async function scalar<T = string>(sql: string, params: unknown[] = []) { return (await pool.query<{ value: T }>(sql, params)).rows[0]?.value; }

async function seed() {
  await pool.query("INSERT INTO users(id,email,status) VALUES($1,$2,'active')", [actor, `${actor}@r15.test`]);
  const ids = await pool.query<{ id: string }>(`INSERT INTO billing_providers(code,name,enabled,environment) VALUES ($1,'R15',true,'sandbox'),($1,'R15',true,'production') RETURNING id`, [code]);
  providerIds = ids.rows.map((r) => r.id);
  await pool.query(`INSERT INTO tenants(name,slug,status) VALUES ('R15 tenant',$1,'active')`, [`r15-${randomUUID()}`]);
  await pool.query(`INSERT INTO invoices(tenant_id,provider_id,external_id,kind,amount_cents,currency,status,due_date) SELECT id,$1,$2,'subscription',100,'BRL','open',now() FROM tenants ORDER BY created_at DESC LIMIT 1`, [providerIds[0], `r15-invoice-${randomUUID()}`]);
  await pool.query(`INSERT INTO payments(tenant_id,invoice_id,provider_id,external_id,amount_cents,currency,status) SELECT i.tenant_id,i.id,$1,$2,100,'BRL','pending' FROM invoices i WHERE i.provider_id=$1 ORDER BY i.created_at DESC LIMIT 1`, [providerIds[0], `r15-payment-${randomUUID()}`]);
}

afterAll(async () => { if (providerIds.length) { await pool.query("DELETE FROM payments WHERE provider_id=ANY($1::uuid[])", [providerIds]); await pool.query("DELETE FROM invoices WHERE provider_id=ANY($1::uuid[])", [providerIds]); await pool.query("DELETE FROM audit_logs WHERE resource_id=ANY($1::text[])", [providerIds]); await pool.query("DELETE FROM users WHERE id=$1", [actor]); await pool.query("DELETE FROM billing_providers WHERE id=ANY($1::uuid[])", [providerIds]); } await pool.end(); });

describe("R15 provider store security", () => {
  it("isolates sandbox and production, encrypts credentials, sanitizes output, and preserves ciphertext", async () => {
    await seed();
    const sandbox = await saveEncryptedCredentials(code, "sandbox", { accessToken: leakedPlaintext, clientSecret: "client-secret" }, actor);
    const productionBefore = await getProvider(code, "production");
    expect(productionBefore?.status).toBe("NOT_CONFIGURED");
    const stored = await scalar<string>("SELECT credentials_encrypted AS value FROM billing_providers WHERE id=$1", [sandbox.id]);
    expect(stored).not.toContain(leakedPlaintext);
    expect(decryptCredentials(stored!, config.DATA_ENCRYPTION_KEY)).toEqual({ accessToken: leakedPlaintext, clientSecret: "client-secret" });
    expect(sandbox.credentials_hint).toBe(`••••${JSON.stringify({ accessToken: leakedPlaintext, clientSecret: "client-secret" }).slice(-4)}`);
    const ciphertextBefore = stored;
    const updated = await updateCommercialConfig(code, "sandbox", { feeBps: 125 });
    expect(updated.commercial_config).toEqual({ feeBps: 125 });
    expect(await scalar("SELECT credentials_encrypted AS value FROM billing_providers WHERE id=$1", [sandbox.id])).toBe(ciphertextBefore);
    const outputKeys = Object.keys((await listProviders())[0] ?? {});
    for (const name of forbidden) expect(outputKeys).not.toContain(name);
  });

  it("disconnects only credentials, keeps financial records, and emits sanitized lifecycle audits", async () => {
    const before = { invoices: await scalar("SELECT count(*)::int AS value FROM invoices WHERE provider_id=$1", [providerIds[0]]), payments: await scalar("SELECT count(*)::int AS value FROM payments WHERE provider_id=$1", [providerIds[0]]) };
    const disconnected = await disconnect(code, "sandbox", actor);
    expect(disconnected.status).toBe("DISCONNECTED");
    expect(await scalar("SELECT credentials_encrypted IS NULL AS value FROM billing_providers WHERE id=$1", [disconnected.id])).toBe(true);
    expect(await scalar("SELECT count(*)::int AS value FROM invoices WHERE provider_id=$1", [providerIds[0]])).toBe(before.invoices);
    expect(await scalar("SELECT count(*)::int AS value FROM payments WHERE provider_id=$1", [providerIds[0]])).toBe(before.payments);
    await expect(disconnect(code, "production", "")).rejects.toThrow("actor");
    await saveEncryptedCredentials(code, "production", leakedPlaintext, actor);
    await markValidationSuccess(code, "production", undefined, actor);
    await markValidationFailure(code, "production", "INVALID_TOKEN", actor);
    const audits = await pool.query<{ action: string; metadata: unknown }>("SELECT action,metadata FROM audit_logs WHERE resource_type='billing_provider' AND resource_id=$1 ORDER BY created_at", [providerIds[1]]);
    expect(audits.rows.map((r) => r.action)).toEqual(expect.arrayContaining(["GATEWAY_CONNECTED", "CREDENTIAL_ROTATED", "AUTH_FAILED"]));
    expect(JSON.stringify(audits.rows)).not.toContain(leakedPlaintext);
  });
});
