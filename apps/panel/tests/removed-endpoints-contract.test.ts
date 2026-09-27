// C4 (auditoria P1): "Melhoria da IA" foi removida do backend
// (specs/done/followups-modulo-e-remocoes.md, R1). Nenhuma tela pode chamar
// esses endpoints: o botão falharia sempre com 404.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

describe("painel não chama endpoints removidos do backend", () => {
  it("nenhum código do painel referencia /agent/evaluations ou /agent/improvement", () => {
    const offenders = ["app", "components", "lib"]
      .flatMap((dir) => sources(join(root, dir)))
      .filter((file) => /\/agent\/(evaluations|improvement)/.test(readFileSync(file, "utf8")))
      .map((file) => file.slice(root.length));
    expect(offenders).toEqual([]);
  });
});
