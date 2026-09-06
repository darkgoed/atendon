import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Guarda contra o defeito mais caro desta base: implementar uma regra comercial
 * e nunca invocá-la. Um módulo que ninguém importa é código inerte — todos os
 * gates passam e a funcionalidade simplesmente não acontece em produção.
 *
 * Este teste falha se alguém remover o agendamento de um job de billing, mesmo
 * que o módulo continue existindo e com testes verdes.
 */

const workerSource = await readFile(fileURLToPath(new URL("../src/worker.ts", import.meta.url)), "utf8");

const BILLING_JOBS = [
  { name: "runBillingReconciliationBatch", module: "./billing/reconciler.js", why: "reconciliação banco x gateway e fechamento de período" },
  { name: "runSubscriptionLifecycleBatch", module: "./billing/reconciler.js", why: "suspensão após carência vencida" },
  { name: "runDunningBatch", module: "./billing/dunning.js", why: "retentativas de cobrança de inadimplentes" },
  { name: "runMercadoPagoReconciliationBatch", module: "./billing/mercadopago-reconciliation.js", why: "detecção de divergências banco x Mercado Pago" },
  { name: "applyScheduledDowngrades", module: "./billing/proration.js", why: "aplicação do downgrade agendado na virada do ciclo" },
  { name: "runOAuthTokenRenewalBatch", module: "./billing/mercadopago-renewal.js", why: "renovação do token OAuth do Mercado Pago" }
] as const;

describe("agendamento dos jobs de billing no worker", () => {
  it.each(BILLING_JOBS)("importa $name de $module ($why)", ({ name, module }) => {
    expect(workerSource).toContain(module);
    expect(workerSource).toContain(name);
  });

  it.each(BILLING_JOBS)("de fato AGENDA $name, não apenas importa", ({ name }) => {
    // A chamada precisa estar dentro de um setInterval; importar sem agendar é
    // exatamente o modo de falha que este teste existe para pegar.
    const scheduled = /setInterval\(\s*\(\)\s*=>\s*\{[\s\S]*?\}\s*,/g;
    const bodies = workerSource.match(scheduled) ?? [];
    expect(bodies.some((body) => body.includes(`${name}(`))).toBe(true);
  });

  it("cada timer de billing é liberado no shutdown", () => {
    for (const timer of [
      "billingReconciler",
      "dunningTimer",
      "mercadopagoReconciliationTimer",
      "subscriptionLifecycleTimer",
      "scheduledDowngradeTimer",
      "oauthTokenRenewalTimer"
    ]) {
      expect(workerSource).toContain(`clearInterval(${timer})`);
      // .unref() impede que o timer segure o processo vivo no encerramento.
      expect(workerSource).toContain(`${timer}.unref()`);
    }
  });

  it("os intervalos são configuráveis por variável de ambiente", () => {
    for (const variable of [
      "BILLING_RECONCILIATION_INTERVAL_MS",
      "SUBSCRIPTION_LIFECYCLE_INTERVAL_MS",
      "DUNNING_INTERVAL_MS",
      "MERCADOPAGO_RECONCILIATION_INTERVAL_MS",
      "SCHEDULED_DOWNGRADE_INTERVAL_MS",
      "OAUTH_TOKEN_RENEWAL_INTERVAL_MS"
    ]) {
      expect(workerSource).toContain(variable);
    }
  });
});
