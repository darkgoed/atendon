import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { getProvider, saveEncryptedCredentials, setEnabled } from "../src/billing/providers/store.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const actor = randomUUID();
let code = "";

beforeEach(async () => {
  code = `enable-${randomUUID()}`;
  await pool.query("INSERT INTO users(id,email,status) VALUES($1,$2,'active') ON CONFLICT (id) DO NOTHING", [actor, `${actor}@enable.test`]);
  await pool.query("INSERT INTO billing_providers(code,name,enabled,environment,homologated) VALUES ($1,'Enable Test',false,'sandbox',true),($1,'Enable Test',false,'production',true)", [code]);
});

afterAll(async () => {
  await pool.query("DELETE FROM audit_logs WHERE resource_id IN (SELECT id::text FROM billing_providers WHERE code LIKE 'enable-%')");
  await pool.query("DELETE FROM billing_providers WHERE code LIKE 'enable-%'");
  await pool.query("DELETE FROM users WHERE id=$1", [actor]);
  await pool.end();
});

describe("billing provider enable/disable", () => {
  it("starts disabled and can be enabled once credentials are connected", async () => {
    const before = await getProvider(code, "production");
    expect(before?.enabled).toBe(false);
    await saveEncryptedCredentials(code, "production", { accessToken: "token" }, actor);
    const enabled = await setEnabled(code, "production", true, actor);
    expect(enabled.enabled).toBe(true);
    const after = await getProvider(code, "production");
    expect(after?.enabled).toBe(true);
  });

  it("refuses to enable a provider without configured credentials", async () => {
    await expect(setEnabled(code, "sandbox", true, actor)).rejects.toThrow("credentials");
  });

  it("can be disabled again, independent of environment", async () => {
    await saveEncryptedCredentials(code, "production", { accessToken: "token" }, actor);
    await setEnabled(code, "production", true, actor);
    const disabled = await setEnabled(code, "production", false, actor);
    expect(disabled.enabled).toBe(false);
    const sandbox = await getProvider(code, "sandbox");
    expect(sandbox?.enabled).toBe(false);
  });

  it("throws when the provider/environment does not exist", async () => {
    await expect(setEnabled("does-not-exist", "production", true, actor)).rejects.toThrow("billing provider not found");
  });
});
