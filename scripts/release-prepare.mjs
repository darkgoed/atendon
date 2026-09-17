#!/usr/bin/env node
// Ops-host entry point (npm run release:prepare): requires a clean checkout,
// records the technical release (version/build/classification) in the
// `releases` table via release-record.mjs, then syncs package-lock.json's
// version field. Never calls the changelog AI — that happens later, out of
// the deploy's critical path, driven by the backend worker's reconciler.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Estado de sessão de agentes vive DENTRO de apps/atendon mas nunca entra numa
// release (regra do AGENTS.md do repositório). Esses caminhos ficam
// permanentemente sujos/untracked na máquina de operação, então tratá-los como
// sujeira travava o release:prepare para sempre — nenhuma versão era
// registrada e o changelog congelava. O gate continua valendo para qualquer
// outro arquivo: só estes são ignorados.
const RELEASE_STATE_DIRS = [".hermes", ".claude", ".agents", ".codex"];
// features.md: mesmo caso de comments.md — colagem de referência feita pelo
// operador/agentes na raiz do app, não é produto.
const RELEASE_STATE_FILES = ["comments.md", "features.md", "skills-lock.json"];

/** Recebe a saída de `git status --porcelain` e devolve só as entradas que
 * realmente impedem a release. Os caminhos podem vir relativos à raiz do
 * repositório (worktree compartilhado) ou ao app, então a comparação é por
 * segmento, nunca por prefixo da string inteira. */
export function blockingStatusEntries(porcelain) {
  return String(porcelain)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => {
      // "XY caminho" — renomeações usam "origem -> destino"; o destino manda.
      const filePath = line.slice(2).trim().split(" -> ").pop() ?? "";
      const segments = filePath.replace(/^"|"$/g, "").split("/").filter(Boolean);
      const isStateDir = segments.some((segment) => RELEASE_STATE_DIRS.includes(segment));
      const isStateFile = RELEASE_STATE_FILES.includes(segments[segments.length - 1] ?? "");
      return !isStateDir && !isStateFile;
    });
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = process.env.RELEASE_ROOT ? path.resolve(process.env.RELEASE_ROOT) : path.resolve(scriptDir, "..");

const isMainModule = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  const env = { ...process.env };
  const clean = spawnSync("git", ["status", "--porcelain", "--", "."], { cwd: root, env, encoding: "utf8" });
  if (clean.status !== 0) throw new Error("release:prepare exige um checkout Git válido");
  const blocking = blockingStatusEntries(clean.stdout);
  if (blocking.length > 0) {
    throw new Error(`release:prepare exige checkout limpo; faça commit do código antes de preparar a release:\n${blocking.join("\n")}`);
  }

  const recorder = spawnSync(process.execPath, ["--env-file-if-exists=.env", path.join("scripts", "release-record.mjs")], { cwd: root, env, encoding: "utf8" });
  if (recorder.status !== 0) throw new Error(recorder.stderr || "registro da release falhou");
  process.stdout.write(recorder.stdout);

  const sync = spawnSync(process.execPath, [path.join("scripts", "sync-package-lock-version.mjs")], { cwd: root, env, encoding: "utf8" });
  if (sync.status !== 0) throw new Error(sync.stderr || "sincronização do package-lock falhou");
  process.stdout.write(sync.stdout);
}
