#!/usr/bin/env node
// Runs on the ops host (npm run release:coolify-tag), never inside a
// Dockerfile/Coolify build. Syncs the DEPLOY_VERSION build-time env var of the
// Coolify application with the latest recorded release, so deploy images are
// tagged by release version instead of a frozen old tag (the v1.22.0 era).
// Requires docker access to the atendon and coolify containers on this host —
// the same ops-host assumption as release:prepare's DATABASE_URL.
//
// Usage: npm run release:coolify-tag
import { execFileSync } from "node:child_process";

const ATENDON_DB_CONTAINER = process.env.ATENDON_DB_CONTAINER ?? "luaj67tqgrdsjlvdjrt9x3ot-postgres-1";
const COOLIFY_CONTAINER = process.env.COOLIFY_CONTAINER ?? "coolify";
const COOLIFY_APPLICATION_INTERNAL_ID = process.env.COOLIFY_APPLICATION_INTERNAL_ID ?? "1";

function dockerExec(container, args) {
  return execFileSync("docker", ["exec", container, ...args], { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
}

// Fonte da verdade: tabela releases (a mesma que release:prepare consulta).
const rawVersion = dockerExec(ATENDON_DB_CONTAINER, [
  "psql", "-U", "atendon", "-d", "atendon", "-t", "-A", "-c",
  "SELECT version FROM releases ORDER BY build_number DESC LIMIT 1"
]);
const version = rawVersion.trim().split("\n").pop()?.trim() ?? "";
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error(`release-coolify-tag: versão inesperada na tabela releases: "${version}"`);
}
const tag = `v${version}`;

// Coolify guarda o valor cifrado (cast 'encrypted'); atualizar via model garante
// a cifra com o APP_KEY do Coolify. Existem linhas duplicadas (escopo preview):
// todas recebem o mesmo valor.
const php = [
  "$ids = \\App\\Models\\EnvironmentVariable::where('key','DEPLOY_VERSION')",
  `->where('resourceable_id',${COOLIFY_APPLICATION_INTERNAL_ID})`,
  "->where('resourceable_type','App\\\\Models\\\\Application')",
  "->pluck('id');",
  "foreach ($ids as $id) {",
  `  \\App\\Models\\EnvironmentVariable::find($id)->update(['value' => '${tag}']);`,
  "}",
  `echo json_encode(['tag' => '${tag}', 'rows' => $ids->count()]);`
].join(" ");

const tinkerOutput = dockerExec(COOLIFY_CONTAINER, ["php", "artisan", "tinker", "--execute=" + php]);
const jsonLine = tinkerOutput.trim().split("\n").find((line) => line.startsWith("{"));
if (!jsonLine) {
  throw new Error(`release-coolify-tag: saída inesperada do tinker: ${JSON.stringify(tinkerOutput.slice(-400))}`);
}
const result = JSON.parse(jsonLine);
if (result.tag !== tag || !(result.rows >= 1)) {
  throw new Error(`release-coolify-tag: atualização não confirmada: ${jsonLine}`);
}
process.stdout.write(`==> DEPLOY_VERSION do Coolify sincronizada: ${result.tag} (${result.rows} linha(s))\n`);
