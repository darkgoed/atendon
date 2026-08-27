import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { syncPackageLockVersion } from "./sync-package-lock-version.mjs";

const rootDirectory = fileURLToPath(new URL("..", import.meta.url));

const composeEnvironment = {
  ...process.env,
  APP_VERSION: "2.3.4",
  DEPLOY_VERSION: "v2.3.4-deadbeef",
  POSTGRES_PASSWORD: "bootstrap-secret",
  ATENDON_MIGRATION_DB_PASSWORD: "migration-secret",
  ATENDON_RUNTIME_DB_PASSWORD: "runtime-secret",
  EVOLUTION_DB_PASSWORD: "evolution-db-secret",
  EVOLUTION_API_KEY: "evolution-api-secret-with-32-characters",
  EVOLUTION_WEBHOOK_SECRET: "evolution-webhook-secret-with-32-characters",
  JWT_SECRET: "jwt-secret-with-at-least-32-characters",
  DATA_ENCRYPTION_KEY: "data-secret-with-at-least-32-characters",
  TENANT_API_KEY: "tenant-secret-with-at-least-32-characters",
  PANEL_SEED_PASSWORD: "StrongSeedPass2026",
  PANEL_ORIGIN: "https://atendon.example",
  PANEL_PUBLIC_URL: "https://atendon.example"
};

function composeConfig() {
  const result = spawnSync("docker", ["compose", "config", "--format", "json"], {
    cwd: rootDirectory,
    env: composeEnvironment,
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("Compose define o stack completo, redes internas e volumes legados estáveis", () => {
  const config = composeConfig();
  const expectedServices = [
    "postgres",
    "database-provision",
    "database-migrate",
    "redis",
    "evolution-postgres",
    "evolution-api",
    "atendon-api",
    "atendon-worker",
    "atendon-panel"
  ];
  assert.deepEqual(Object.keys(config.services).sort(), expectedServices.sort());

  for (const name of expectedServices.filter((service) => !service.startsWith("database-"))) {
    assert.equal(config.services[name].restart, "unless-stopped", `${name} sem restart`);
    assert.ok(config.services[name].healthcheck, `${name} sem healthcheck`);
  }
  for (const name of ["database-provision", "database-migrate"]) {
    assert.equal(config.services[name].restart, "no", `${name} deve ser um job one-shot`);
  }
  for (const name of ["atendon-api", "atendon-worker", "atendon-panel"]) {
    assert.equal(config.services[name].init, true, `${name} sem init`);
  }

  assert.equal(config.services["atendon-api"].environment.CONTAINER_RUNTIME, "true");
  assert.equal(config.services["atendon-api"].environment.HOST, "0.0.0.0");
  assert.match(config.services["atendon-api"].environment.DATABASE_URL, /@postgres:5432\/atendon$/);
  assert.equal(config.services["atendon-api"].environment.REDIS_URL, "redis://redis:6379");
  assert.equal(config.services["atendon-api"].environment.EVOLUTION_API_URL, "http://evolution-api:8080");
  assert.equal(config.services["atendon-api"].environment.MEET_JWT_SECRET, undefined);
  assert.equal(config.services["atendon-worker"].environment.MEET_JWT_SECRET, undefined);
  for (const privilegedName of ["POSTGRES_PASSWORD", "MIGRATION_DATABASE_URL", "ATENDON_MIGRATION_DB_PASSWORD"]) {
    assert.equal(config.services["atendon-api"].environment[privilegedName], undefined);
    assert.equal(config.services["atendon-worker"].environment[privilegedName], undefined);
  }
  assert.equal(config.services["atendon-panel"].environment.BACKEND_URL, "http://atendon-api:3110");
  assert.equal(config.services["evolution-api"].environment.CACHE_REDIS_URI, "redis://redis:6379/1");
  assert.match(config.services["evolution-api"].environment.DATABASE_CONNECTION_URI, /@evolution-postgres:5432\/evolution$/);

  assert.equal(config.services["atendon-panel"].depends_on["atendon-api"].condition, "service_healthy");
  assert.equal(config.services["database-provision"].depends_on.postgres.condition, "service_healthy");
  assert.equal(config.services["database-migrate"].depends_on["database-provision"].condition, "service_completed_successfully");
  assert.equal(config.services["atendon-api"].depends_on["database-migrate"].condition, "service_completed_successfully");
  assert.equal(config.services["atendon-worker"].depends_on["database-migrate"].condition, "service_completed_successfully");
  assert.equal(config.services["atendon-worker"].depends_on.redis.condition, "service_healthy");
  assert.match(config.services["atendon-worker"].healthcheck.test.join(" "), /p!==self/);

  for (const [logicalName, physicalName] of Object.entries({
    atendon_postgres: "atendon_atendon_postgres",
    atendon_redis: "atendon_atendon_redis",
    atendon_evolution_postgres: "atendon_atendon_evolution_postgres",
    atendon_evolution_instances: "atendon_atendon_evolution_instances"
  })) {
    assert.equal(config.volumes[logicalName].name, physicalName);
    assert.equal(config.volumes[logicalName].external, true, `${logicalName} deve adotar o volume legado e nunca criar um volume vazio prefixado pelo Coolify`);
  }
});

test("Compose exige segredos em runtime e não contém credenciais padrão", async () => {
  const source = await readFile(join(rootDirectory, "docker-compose.yml"), "utf8");
  for (const name of [
    "POSTGRES_PASSWORD",
    "ATENDON_MIGRATION_DB_PASSWORD",
    "ATENDON_RUNTIME_DB_PASSWORD",
    "EVOLUTION_DB_PASSWORD",
    "EVOLUTION_API_KEY",
    "EVOLUTION_WEBHOOK_SECRET",
    "JWT_SECRET",
    "DATA_ENCRYPTION_KEY",
    "TENANT_API_KEY",
    "PANEL_SEED_PASSWORD"
  ]) {
    assert.match(source, new RegExp(`\\$\\{${name}:\\?`), `${name} deve ser obrigatória`);
  }
  assert.doesNotMatch(source, /change-this-|local-evolution-key|:-evolution\}/);
  const dockerIgnore = await readFile(join(rootDirectory, ".dockerignore"), "utf8");
  assert.match(dockerIgnore, /^\.env$/m);
  assert.match(dockerIgnore, /^\.env\.\*$/m);
});

test("@atendon/panel declara dotenv como dependência própria (next.config.ts o importa diretamente)", async () => {
  const panelPackageJson = JSON.parse(await readFile(join(rootDirectory, "apps/panel/package.json"), "utf8"));
  assert.ok(
    panelPackageJson.dependencies?.dotenv,
    "apps/panel/package.json deve declarar dotenv; o build da imagem instala somente o workspace do painel e não herda a dependência do backend"
  );
});

test("comandos operacionais do Compose carregam os arquivos privados de runtime e migration", async () => {
  const [helper, build, dump, restore, migrationExample] = await Promise.all([
    readFile(join(rootDirectory, "deploy/compose.sh"), "utf8"),
    readFile(join(rootDirectory, "build.sh"), "utf8"),
    readFile(join(rootDirectory, "deploy/postgres/pg-dump-compose.sh"), "utf8"),
    readFile(join(rootDirectory, "deploy/postgres/pg-restore-compose.sh"), "utf8"),
    readFile(join(rootDirectory, ".env.migration.example"), "utf8")
  ]);
  assert.match(helper, /--env-file[^\n]*\.env/);
  assert.match(helper, /--env-file[^\n]*\.env\.migration/);
  assert.match(build, /deploy\/compose\.sh/);
  assert.match(dump, /deploy\/compose\.sh/);
  assert.match(restore, /deploy\/compose\.sh/);
  assert.match(migrationExample, /^EVOLUTION_DB_PASSWORD=/m);
});

test("Dockerfiles de produção usam Node 22, npm 12, usuário não-root e comandos distintos", async () => {
  const files = {
    api: await readFile(join(rootDirectory, "deploy/docker/api.Dockerfile"), "utf8"),
    worker: await readFile(join(rootDirectory, "deploy/docker/worker.Dockerfile"), "utf8"),
    panel: await readFile(join(rootDirectory, "deploy/docker/panel.Dockerfile"), "utf8")
  };
  for (const [name, source] of Object.entries(files)) {
    assert.match(source, /FROM node:22(?:[.-])/i, `${name} não usa Node 22`);
    assert.match(source, /npm@12\.0\.1/, `${name} não fixa npm 12`);
    assert.match(source, /USER node/, `${name} não usa usuário node`);
  }
  assert.match(files.api, /dist\/server\.js/);
  assert.match(files.api, /src\/db\/migrations/);
  assert.doesNotMatch(
    files.api,
    /instrução-newave-ia\.md/,
    "a API deve usar o prompt persistido no banco, sem template Markdown em runtime"
  );
  assert.match(files.worker, /dist\/worker\.js/);
  assert.match(files.panel, /standalone/);
  assert.match(files.panel, /server\.js/);
  await Promise.all([
    readFile(join(rootDirectory, "ecosystem.config.js"), "utf8"),
    readFile(join(rootDirectory, "deploy/start-panel.sh"), "utf8")
  ]);
});

test("build.sh valida candidatos antes da troca e oferece rollback do stack sem PM2 ou Git write", async () => {
  const buildFile = join(rootDirectory, "build.sh");
  const syntax = spawnSync("bash", ["-n", buildFile], { encoding: "utf8" });
  assert.equal(syntax.status, 0, syntax.stderr);
  const source = await readFile(buildFile, "utf8");
  const position = (needle) => {
    const index = source.indexOf(needle);
    assert.notEqual(index, -1, `trecho obrigatório ausente: ${needle}`);
    return index;
  };
  const lastPosition = (needle) => {
    const index = source.lastIndexOf(needle);
    assert.notEqual(index, -1, `trecho obrigatório ausente: ${needle}`);
    return index;
  };

  assert.doesNotMatch(source, /\bpm2\b/i);
  assert.doesNotMatch(source, /git (?:add|commit|push)/);
  assert.doesNotMatch(source, /systemctl/);
  assert.match(source, /flock -n/);
  assert.match(source, /npm ci --include=dev/);
  assert.match(source, /npm run lint/);
  assert.match(source, /npm run typecheck/);
  assert.match(source, /npm test/);
  assert.match(source, /npm run test:e2e/);
  assert.match(source, /npm run backup:database/);
  assert.match(source, /npm run restore:verify/);
  assert.match(source, /npm run migrate -w @atendon\/backend/);
  assert.match(source, /npm run provision:tripz -w @atendon\/backend/);
  assert.match(source, /npm run snapshot:deploy -w @atendon\/backend/);
  assert.match(source, /rollback_stack/);
  assert.match(source, /compose up[^\n]*--wait/);
  assert.match(source, /trap 'deployment_failed \$\{LINENO\} \$\?' ERR/);

  const tests = position("npm test");
  const e2e = position("npm run test:e2e");
  const imageBuild = position('compose build "${APP_SERVICES[@]}"');
  const imageValidation = lastPosition("validate_candidate_images");
  const backup = position("npm run backup:database");
  const restore = position("npm run restore:verify");
  const migration = position("npm run migrate -w @atendon/backend");
  const provision = position("npm run provision:tripz -w @atendon/backend");
  const snapshot = position("npm run snapshot:deploy -w @atendon/backend");
  const switchStack = position('compose up -d --no-build --wait "${APP_SERVICES[@]}"');
  const versionCheck = lastPosition("verify_version_endpoint");
  assert.ok(tests < e2e && e2e < imageBuild && imageBuild < imageValidation);
  assert.ok(imageValidation < backup && backup < restore && restore < migration);
  assert.ok(migration < provision && provision < snapshot && snapshot < switchStack);
  assert.ok(switchStack < versionCheck);
});

test("deploy/compose.sh detecta o project-name real do stack em execução (Coolify usa o UUID, não o nome do diretório)", async () => {
  const binDir = await mkdtemp(join(tmpdir(), "atendon-fake-docker-"));
  const logFile = join(binDir, "compose-calls.log");
  const fakeDocker = `#!/bin/sh
set -eu
if [ "$1" = "ps" ]; then
  printf '%s\\n' "\${FAKE_DOCKER_PS_OUTPUT:-}"
  exit 0
fi
if [ "$1" = "compose" ]; then
  shift
  printf '%s\\n' "$*" >> "${logFile}"
  exit 0
fi
echo "unexpected docker invocation: $*" >&2
exit 1
`;
  await writeFile(join(binDir, "docker"), fakeDocker, { mode: 0o755 });
  const runCompose = (env) => spawnSync(join(rootDirectory, "deploy/compose.sh"), ["ps"], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH}`, ...env }
  });

  try {
    const detected = runCompose({ FAKE_DOCKER_PS_OUTPUT: "luaj67tqgrdsjlvdjrt9x3ot" });
    assert.equal(detected.status, 0, detected.stderr);
    const detectedLog = await readFile(logFile, "utf8");
    assert.match(detectedLog, /--project-name luaj67tqgrdsjlvdjrt9x3ot/, "deve usar o project-name do stack detectado em execução");
    await rm(logFile);

    const ambiguous = runCompose({ FAKE_DOCKER_PS_OUTPUT: "atendon\nluaj67tqgrdsjlvdjrt9x3ot" });
    assert.equal(ambiguous.status, 0, ambiguous.stderr);
    const ambiguousLog = await readFile(logFile, "utf8");
    assert.doesNotMatch(ambiguousLog, /--project-name/, "não deve adivinhar quando há mais de um projeto ativo");
    await rm(logFile);

    const none = runCompose({ FAKE_DOCKER_PS_OUTPUT: "" });
    assert.equal(none.status, 0, none.stderr);
    const noneLog = await readFile(logFile, "utf8");
    assert.doesNotMatch(noneLog, /--project-name/, "sem stack rodando, usa o comportamento padrão do Compose");
    await rm(logFile);

    const explicit = runCompose({ FAKE_DOCKER_PS_OUTPUT: "should-not-be-used", COMPOSE_PROJECT_NAME: "explicit-override" });
    assert.equal(explicit.status, 0, explicit.stderr);
    const explicitLog = await readFile(logFile, "utf8");
    assert.doesNotMatch(explicitLog, /--project-name/, "uma COMPOSE_PROJECT_NAME explícita não deve ser sobrescrita nem gerar detecção");
  } finally {
    await rm(binDir, { recursive: true, force: true });
  }
});

test("rollback retagueia as imagens anteriores e recria o stack anterior", async () => {
  const directory = await mkdtemp(join(tmpdir(), "atendon-stack-rollback-"));
  const stackFile = join(directory, "stack-before.tsv");
  const actionFile = join(directory, "actions.log");
  try {
    await writeFile(stackFile, [
      "evolution-api\tsha256:evolution-before",
      "atendon-api\tsha256:api-before",
      "atendon-worker\tsha256:worker-before",
      "atendon-panel\tsha256:panel-before"
    ].join("\n") + "\n");
    const result = spawnSync("bash", ["-c", `
      set -Eeuo pipefail
      export ATENDON_BUILD_FUNCTIONS_ONLY=1
      source "$1"
      PREVIOUS_STACK_FILE="$2"
      ROLLBACK_LOG_FILE="$3"
      PREVIOUS_APP_VERSION="1.9.0"
      PREVIOUS_DEPLOY_VERSION="v1.9.0-previous"
      APP_VERSION="2.0.0"
      DEPLOY_VERSION="v2.0.0-candidate"
      ATENDON_IMAGE_PREFIX="atendon-test"
      ACTION_FILE="$4"
      docker() { printf 'docker %s\\n' "$*" >> "$ACTION_FILE"; }
      compose() { printf 'compose %s\\n' "$*" >> "$ACTION_FILE"; }
      rollback_stack simulated-health-failure
      printf 'versions %s %s\\n' "$APP_VERSION" "$DEPLOY_VERSION" >> "$ACTION_FILE"
    `, "bash", join(rootDirectory, "build.sh"), stackFile, join(directory, "rollback.log"), actionFile], {
      encoding: "utf8"
    });
    assert.equal(result.status, 0, result.stderr);
    const actions = await readFile(actionFile, "utf8");
    assert.match(actions, /docker image tag sha256:api-before atendon-test\/api:v1\.9\.0-previous/);
    assert.match(actions, /docker image tag sha256:worker-before atendon-test\/worker:v1\.9\.0-previous/);
    assert.match(actions, /docker image tag sha256:panel-before atendon-test\/panel:v1\.9\.0-previous/);
    assert.match(actions, /compose up -d --no-deps --no-build --force-recreate --wait evolution-api atendon-api atendon-worker atendon-panel/);
    assert.match(actions, /versions 1\.9\.0 v1\.9\.0-previous/);
    assert.match(await readFile(join(directory, "rollback.log"), "utf8"), /forward-only/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("nginx mantém a página de atualização disponível para a janela de troca", async () => {
  const [nginx, maintenance, ignore] = await Promise.all([
    readFile(join(rootDirectory, "deploy/nginx/atendon.conf"), "utf8"),
    readFile(join(rootDirectory, "deploy/nginx/error-pages/maintenance.html"), "utf8"),
    readFile(join(rootDirectory, ".gitignore"), "utf8")
  ]);
  assert.match(nginx, /if \(-f \/var\/www\/apps\/atendon\/deploy\/nginx\/maintenance\.flag\)/);
  assert.match(nginx, /return 503/);
  assert.match(nginx, /error_page 502 503 504 \/maintenance\.html/);
  assert.match(maintenance, /Atualizando o sistema/);
  assert.match(maintenance, /http-equiv="refresh"/);
  assert.match(ignore, /deploy\/nginx\/maintenance\.flag/);
});

test("sincroniza somente as versões raiz do package-lock", async () => {
  const directory = await mkdtemp(join(tmpdir(), "atendon-lock-version-"));
  try {
    await writeFile(join(directory, "package.json"), JSON.stringify({ version: "2.3.4" }));
    await writeFile(join(directory, "package-lock.json"), JSON.stringify({
      name: "fixture",
      version: "1.0.0",
      lockfileVersion: 3,
      packages: {
        "": { name: "fixture", version: "1.0.0" },
        "node_modules/dependency": { version: "1.0.0" }
      }
    }));
    await syncPackageLockVersion(directory);
    const lock = JSON.parse(await readFile(join(directory, "package-lock.json"), "utf8"));
    assert.equal(lock.version, "2.3.4");
    assert.equal(lock.packages[""].version, "2.3.4");
    assert.equal(lock.packages["node_modules/dependency"].version, "1.0.0");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
