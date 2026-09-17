import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * T4.4 (auditoria multi-WhatsApp): reconcileBusinessHoursPresence escolhia
 * sessões pelo status 'connected' sem filtrar archived_at — arquivar a conexão
 * conectada mais recente fazia o worker reconciliar presença de uma conexão
 * morta. A correção adiciona `archived_at IS NULL` ao WHERE.
 *
 * worker.ts dispara BullMQ/redis/runtime ao ser importado, então este guarda é
 * no código-fonte (mesmo padrão de tests/billing-jobs-scheduling.test.ts): falha
 * se alguém remover o filtro do WHERE da reconciliação.
 */

const workerSource = await readFile(fileURLToPath(new URL("../src/worker.ts", import.meta.url)), "utf8");

describe("reconcileBusinessHoursPresence (T4.4)", () => {
  it("só reconcilia presença de conexões não arquivadas", () => {
    const start = workerSource.indexOf("const reconcileBusinessHoursPresence");
    expect(start, "reconcileBusinessHoursPresence deve existir no worker").toBeGreaterThan(-1);
    const body = workerSource.slice(start, workerSource.indexOf("const businessHoursTicker"));
    expect(body).toContain("archived_at IS NULL");
    // O filtro precisa estar no WHERE da seleção de sessões conectadas.
    expect(body).toMatch(/WHERE s\.status\s*=\s*'connected'[\s\S]*?archived_at IS NULL/);
  });
});
