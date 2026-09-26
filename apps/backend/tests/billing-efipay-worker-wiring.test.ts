import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Guarda de wiring da reconciliação mensal Efí (Pix) no worker real.
 *
 * Mesmo padrão de tests/billing-jobs-scheduling.test.ts: worker.ts dispara
 * BullMQ/redis/runtime ao ser importado, então a verificação é no código-fonte.
 * Falha se alguém remover o agendamento periódico, a execução no boot, o
 * unref(), o guarda anti-sobreposição ou o teardown do timer no shutdown.
 *
 * O módulo ./billing/efipay-monthly-batch.js é construído em paralelo; este
 * teste não o importa — só exige que o worker o importe e o agende.
 */

const workerSource = await readFile(fileURLToPath(new URL("../src/worker.ts", import.meta.url)), "utf8");

const BATCH_MODULE = "./billing/efipay-monthly-batch.js";
const BATCH_FN = "runEfiPixMonthlyBatch";
const TIMER = "efiMonthlyBatchTimer";
const JOB_FN = "runEfiMonthlyBatchJob";
const GUARD = "efiMonthlyBatchRunning";

const jobStart = workerSource.indexOf(`const ${JOB_FN}`);
const timerStart = workerSource.indexOf(`const ${TIMER}`);

describe("wiring da reconciliação mensal Efí no worker", () => {
  it(`importa ${BATCH_FN} de ${BATCH_MODULE}`, () => {
    expect(workerSource).toContain(BATCH_MODULE);
    expect(workerSource).toContain(BATCH_FN);
  });

  it("de fato AGENDA o lote em um setInterval, não apenas importa", () => {
    expect(timerStart).toBeGreaterThan(-1);
    const scheduled = workerSource.slice(timerStart, timerStart + 200);
    expect(scheduled).toContain(`setInterval(${JOB_FN}`);
  });

  it("roda a cada ~1h configurável por EFIPIX_MONTHLY_BATCH_INTERVAL_MS", () => {
    const scheduled = workerSource.slice(timerStart, timerStart + 200);
    expect(scheduled).toContain("EFIPIX_MONTHLY_BATCH_INTERVAL_MS");
    expect(scheduled).toMatch(/\?\?\s*3_600_000/);
  });

  it("executa no startup, fora do timer", () => {
    // Chamada nua na própria linha (a invocação dentro de setInterval é por
    // referência, sem parênteses — então esta só pode ser a do boot).
    expect(workerSource).toMatch(new RegExp(`^\\s*${JOB_FN}\\(\\);\\s*$`, "m"));
  });

  it("libera o timer do loop de eventos com .unref()", () => {
    expect(workerSource).toContain(`${TIMER}.unref()`);
  });

  it("evita ticks concorrentes com guarda resetada em sucesso E falha", () => {
    expect(jobStart).toBeGreaterThan(-1);
    const jobBody = workerSource.slice(jobStart, timerStart);
    expect(jobBody).toContain(`if (${GUARD}) return;`);
    expect(jobBody).toContain(`${GUARD} = true`);
    // .finally garante a liberação da guarda nos dois caminhos; sem ela, um
    // erro travaria o job para sempre.
    expect(jobBody).toContain(".finally(");
    expect(jobBody).toContain(`${GUARD} = false`);
  });

  it("passa limit=50 ao lote", () => {
    const jobBody = workerSource.slice(jobStart, timerStart);
    expect(jobBody).toContain(`${BATCH_FN}(50)`);
  });

  it("loga contagens genéricas, nunca credenciais", () => {
    const jobBody = workerSource.slice(jobStart, timerStart);
    expect(jobBody).toContain("{ counts }");
    // Nenhum acesso a variáveis de ambiente dentro do job de log.
    expect(jobBody).not.toMatch(/process\.env/);
  });

  it("falhas por item viram ERROR com contagens, sem descartá-las", () => {
    const jobBody = workerSource.slice(jobStart, timerStart);
    expect(jobBody).toContain("batch had item failures");
    expect(jobBody).toMatch(/logger\.error\(\s*\{\s*counts,/);
    expect(jobBody).toContain("errors.slice(0, 20)");
    expect(jobBody).toContain("message.slice(0, 200)");
  });

  it("teardown do timer no shutdown existente", () => {
    const shutdownStart = workerSource.indexOf("async function shutdown");
    expect(shutdownStart).toBeGreaterThan(-1);
    const shutdownBody = workerSource.slice(shutdownStart);
    expect(shutdownBody).toContain(`clearInterval(${TIMER})`);
  });
});
