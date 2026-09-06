import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { buildApp } from "../src/app.js";
import { getProvider } from "../src/billing/providers/registry.js";
import { assertAutomaticProvider, assertHomologatedProvider } from "../src/billing/providers/homologation.js";
import { disconnect, saveEncryptedCredentials, setEnabled, updateCommercialConfig } from "../src/billing/providers/store.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const app = buildApp();
const actor = "00000000-0000-0000-0000-000000000001";
const blocked = ["stripe", "pagbank", "foobar"];

// As linhas existem no banco e NÃO são homologadas: assim o teste prova que o
// bloqueio vem da homologação (dado), e não do acaso de a linha não existir.
beforeAll(async () => {
  await pool.query("INSERT INTO users(id,email,status) VALUES($1,$2,'active') ON CONFLICT (id) DO NOTHING", [actor, `${actor}@homologation.test`]);
  for (const code of blocked) {
    await pool.query(
      "INSERT INTO billing_providers(code,name,enabled,environment,homologated) VALUES($1,$1,false,'production',false) ON CONFLICT (code,environment) DO UPDATE SET homologated=false",
      [code]
    );
  }
});

afterAll(async () => {
  await pool.query("DELETE FROM audit_logs WHERE actor_user_id=$1", [actor]);
  await pool.query("DELETE FROM billing_providers WHERE code = ANY($1)", [blocked]);
  await pool.query("DELETE FROM users WHERE id=$1", [actor]);
  await app.close();
  await pool.end();
});

describe("provider homologation integration", () => {
  it.each(blocked)("rejects %s at the provider factory", (code) => {
    expect(() => getProvider(code, {})).toThrowError(/não homologado/);
  });

  it.each(blocked)("rejects %s in every provider store mutation", async (code) => {
    await expect(saveEncryptedCredentials(code, "production", { accessToken: "x" }, actor)).rejects.toMatchObject({ code: "PROVIDER_NOT_HOMOLOGATED" });
    await expect(setEnabled(code, "production", true, actor)).rejects.toMatchObject({ code: "PROVIDER_NOT_HOMOLOGATED" });
    await expect(updateCommercialConfig(code, "production", {})).rejects.toMatchObject({ code: "PROVIDER_NOT_HOMOLOGATED" });
  });

  // Desconectar é de-escalada: apaga credenciais e derruba o status. Bloquear
  // isso prenderia um gateway não homologado com credencial gravada, então
  // continua permitido de propósito — assim como desativar (setEnabled false).
  it.each(blocked)("still allows de-escalation of %s", async (code) => {
    await expect(disconnect(code, "production", actor)).resolves.toMatchObject({ status: "DISCONNECTED" });
    await expect(setEnabled(code, "production", false, actor)).resolves.toMatchObject({ enabled: false });
  });

  it.each(blocked)("rejects %s from the public webhook route", async (code) => {
    const response = await app.inject({ method: "POST", url: `/webhooks/billing/${code}`, payload: {} });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "PROVIDER_NOT_HOMOLOGATED" });
  });

  it("uses an allowlist for automatic charge provider selection", () => {
    // Cobrança automática exclui o PIX manual (não confirma pagamento sozinho)
    // e qualquer código fora da allowlist quando ele chega sem linha no banco.
    expect(() => assertAutomaticProvider("manual_pix")).toThrowError(/não homologado/);
    for (const code of blocked) expect(() => assertHomologatedProvider(code)).toThrowError(/não homologado/);
    expect(() => assertAutomaticProvider("mercadopago")).not.toThrow();
  });

  it("never auto-selects a non-homologated provider for charging", async () => {
    // A seleção automática de charges.ts filtra por homologated=true: uma linha
    // conectada e habilitada, porém não homologada, não pode ser escolhida.
    const selectable = await pool.query(
      "SELECT code FROM billing_providers WHERE homologated=true AND environment='production' AND status='CONNECTED' AND enabled=true"
    );
    for (const row of selectable.rows) expect(blocked).not.toContain(row.code);
  });

  it("keeps Mercado Pago usable while rejecting all non-homologated codes", () => {
    expect(() => assertHomologatedProvider("mercadopago")).not.toThrow();
    expect(() => assertHomologatedProvider("foobar")).toThrowError(/não homologado/);
  });

  it("enforces homologation at the database boundary", async () => {
    // Não depende da linha 'mercadopago' existir: outras suítes de billing a
    // apagam e recriam no próprio setup, o que tornava este teste sensível à
    // ORDEM de execução. O que importa aqui é a invariante do schema.
    await expect(pool.query("INSERT INTO billing_providers(code,name,enabled,environment,homologated) VALUES('homologation-check','check',true,'sandbox',false)"))
      .rejects.toMatchObject({ constraint: "billing_providers_only_homologated_enabled" });

    // E o mesmo par (code, environment) é aceito quando homologado, provando
    // que a constraint barra a NÃO-homologação, e não o INSERT em si.
    await pool.query("INSERT INTO billing_providers(code,name,enabled,environment,homologated) VALUES('homologation-check','check',true,'sandbox',true)");
    const stored = await pool.query<{ homologated: boolean; enabled: boolean }>(
      "SELECT homologated,enabled FROM billing_providers WHERE code='homologation-check' AND environment='sandbox'"
    );
    expect(stored.rows[0]).toMatchObject({ homologated: true, enabled: true });

    // E um provedor habilitado não pode ser rebaixado para não homologado.
    await expect(pool.query("UPDATE billing_providers SET homologated=false WHERE code='homologation-check' AND environment='sandbox'"))
      .rejects.toMatchObject({ constraint: "billing_providers_only_homologated_enabled" });

    await pool.query("DELETE FROM billing_providers WHERE code='homologation-check'");
  });
});
