import { readFile } from "node:fs/promises";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { getProvider, listProviders, saveEncryptedCredentials, disconnect, updateCommercialConfig } from "../src/billing/providers/store.js";

/**
 * Provisionamento de billing_providers (0140).
 *
 * Antes desta migration a tabela nascia VAZIA e nenhum caminho do sistema
 * inseria linhas: toda a camada de provedores faz apenas UPDATE ... WHERE
 * code AND environment. Consequencia: a tela ROOT de Gateways renderizava os
 * cards, mas qualquer acao (salvar credencial, OAuth, desconectar) explodia
 * com "billing provider not found". Estes testes exercitam o caminho real da
 * UI, nao apenas a presenca das linhas.
 */
const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const MIGRATION = new URL("../src/db/migrations/0140_billing_provider_provisioning.sql", import.meta.url);
let actor = "";

beforeAll(async () => {
  actor = (await pool.query<{ id: string }>(
    `INSERT INTO users(email,name,password_hash,status,is_root)
     VALUES($1,'Provisioning Test','x','active',true) RETURNING id`,
    [`provisioning-${Date.now()}@test.local`]
  )).rows[0].id;
  // Outras suítes de billing apagam as linhas de mercadopago/production no seu
  // próprio setup. Reaplicar a migration (idempotente por construção) torna
  // este teste independente da ordem de execução, em vez de depender de um
  // estado global que outra suíte pode ter destruído.
  await pool.query(await readFile(MIGRATION, "utf8"));
  // 0140 recria as linhas sem opinar sobre homologação (a coluna só nasce em
  // 0142). Reafirmamos aqui a regra de 0142 para que a suíte enxergue o mesmo
  // estado de um banco totalmente migrado.
  await pool.query("UPDATE billing_providers SET homologated=true WHERE code='mercadopago'");
});

afterAll(async () => {
  // Restaura o estado de fabrica das linhas provisionadas.
  await pool.query(
    `UPDATE billing_providers SET credentials_encrypted=NULL, credentials_hint=NULL,
       webhook_secret_encrypted=NULL, status='NOT_CONFIGURED', enabled=false,
       commercial_config='{}'::jsonb, connected_at=NULL
     WHERE code IN ('mercadopago','manual_pix')`
  );
  await pool.query("DELETE FROM audit_logs WHERE actor_user_id=$1", [actor]);
  await pool.query("DELETE FROM users WHERE id=$1", [actor]);
  await pool.end();
});

describe("provisionamento de billing_providers", () => {
  it("cria os pares (code, environment) que a tela de Gateways precisa", async () => {
    // O banco de teste é persistente, então checar apenas "as linhas existem"
    // provaria pouco: elas poderiam vir de uma execução anterior. Verificamos o
    // ARQUIVO da migration, que é o que roda em produção, além do estado atual.
    const sql = await readFile(new URL("../src/db/migrations/0140_billing_provider_provisioning.sql", import.meta.url), "utf8");
    expect(sql).toMatch(/INSERT INTO billing_providers/i);
    expect(sql).toMatch(/ON CONFLICT \(code, environment\) DO NOTHING/i);
    for (const pair of ["'mercadopago', 'Mercado Pago', false, 'sandbox'", "'mercadopago', 'Mercado Pago', false, 'production'"]) {
      expect(sql).toContain(pair);
    }

    const rows = await pool.query<{ code: string; environment: string; enabled: boolean; status: string }>(
      "SELECT code,environment,enabled,status FROM billing_providers ORDER BY code,environment"
    );
    const pairs = rows.rows.map((r) => `${r.code}/${r.environment}`);
    expect(pairs).toContain("mercadopago/production");
    expect(pairs).toContain("mercadopago/sandbox");
    expect(pairs).toContain("manual_pix/production");
    expect(pairs).toContain("manual_pix/sandbox");
  });

  it("é idempotente: reaplicar a migration não duplica nem sobrescreve", async () => {
    // Simula a reexecução da migration num banco que já a aplicou.
    // Usa mercadopago porque, desde 0142, apenas um provedor homologado pode
    // ficar enabled=true — habilitar manual_pix violaria a constraint.
    const sql = await readFile(new URL("../src/db/migrations/0140_billing_provider_provisioning.sql", import.meta.url), "utf8");
    await pool.query("UPDATE billing_providers SET status='CONNECTED', enabled=true WHERE code='mercadopago' AND environment='production'");
    await pool.query(sql);
    const rows = await pool.query<{ n: string; status: string; enabled: boolean }>(
      `SELECT count(*)::text n, max(status) status, bool_or(enabled) enabled
         FROM billing_providers WHERE code='mercadopago' AND environment='production'`
    );
    expect(rows.rows[0].n).toBe("1");
    // Um provedor já configurado não pode ser rebaixado por uma reexecução.
    expect(rows.rows[0].status).toBe("CONNECTED");
    expect(rows.rows[0].enabled).toBe(true);
    await pool.query("UPDATE billing_providers SET status='NOT_CONFIGURED', enabled=false WHERE code='mercadopago' AND environment='production'");
  });

  it("nasce desabilitado e sem credencial: provisionar não coloca gateway em operação", async () => {
    const rows = await pool.query<{ enabled: boolean; status: string; credentials_encrypted: string | null }>(
      "SELECT enabled,status,credentials_encrypted FROM billing_providers WHERE code='mercadopago'"
    );
    for (const row of rows.rows) {
      expect(row.enabled).toBe(false);
      expect(row.status).toBe("NOT_CONFIGURED");
      expect(row.credentials_encrypted).toBeNull();
    }
  });

  it("não cria stubs que quebrariam em runtime se selecionados", async () => {
    // stripe.ts e pagbank.ts são stubs que lançam NotImplementedError.
    const rows = await pool.query("SELECT 1 FROM billing_providers WHERE code IN ('stripe','pagbank')");
    expect(rows.rowCount).toBe(0);
  });

  it("salvar credencial pela tela de Gateways agora funciona (antes: provider not found)", async () => {
    const saved = await saveEncryptedCredentials("mercadopago", "production", { clientId: "cid", clientSecret: "csec" }, actor);
    expect(saved.status).toBe("CONNECTED");
    expect(saved.credentials_hint).toBeTruthy();
    // O segredo nunca volta na resposta da API.
    expect(saved as unknown as Record<string, unknown>).not.toHaveProperty("credentials_encrypted");

    const stored = await getProvider("mercadopago", "production");
    expect(stored?.status).toBe("CONNECTED");
  });

  it("configuração comercial e desconexão também operam sobre a linha provisionada", async () => {
    const configured = await updateCommercialConfig("mercadopago", "production", { autoCharge: false, defaultMethod: "pix" });
    expect(configured.commercial_config).toMatchObject({ autoCharge: false, defaultMethod: "pix" });

    const gone = await disconnect("mercadopago", "production", actor);
    expect(gone.status).toBe("DISCONNECTED");
    expect(gone.credentials_hint).toBeNull();
  });

  it("sandbox e production são registros independentes", async () => {
    await saveEncryptedCredentials("mercadopago", "sandbox", { clientId: "sandbox-cid", clientSecret: "sandbox-sec" }, actor);
    const sandbox = await getProvider("mercadopago", "sandbox");
    const production = await getProvider("mercadopago", "production");
    expect(sandbox?.status).toBe("CONNECTED");
    // Produção continua desconectada pelo teste anterior: os ambientes não se misturam.
    expect(production?.status).toBe("DISCONNECTED");
    expect(sandbox?.id).not.toBe(production?.id);
  });

  it("listProviders nunca expõe segredos ao painel", async () => {
    const all = await listProviders();
    expect(all.length).toBeGreaterThanOrEqual(4);
    for (const provider of all) {
      expect(provider as unknown as Record<string, unknown>).not.toHaveProperty("credentials_encrypted");
      expect(provider as unknown as Record<string, unknown>).not.toHaveProperty("webhook_secret_encrypted");
    }
  });
});
