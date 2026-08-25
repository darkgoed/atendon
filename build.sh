#!/usr/bin/env bash

set -Eeuo pipefail
umask 077

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="${ROOT_DIR}/docker-compose.yml"
APP_SERVICES=(atendon-api atendon-worker atendon-panel)
ROLLBACK_SERVICES=(evolution-api "${APP_SERVICES[@]}")
BUILD_LOCK="${TMPDIR:-/tmp}/atendon-build.lock"
DEPLOY_STATE_ROOT="${ATENDON_DEPLOY_STATE_DIR:-${ROOT_DIR}/.deploy-state}"
RUN_ID="$(date -u +'%Y%m%dT%H%M%SZ')-$$"
RUN_DIR="${DEPLOY_STATE_ROOT}/runs/${RUN_ID}"
BACKUP_DIR="${ATENDON_BACKUP_DIR:-${DEPLOY_STATE_ROOT}/backups/${RUN_ID}}"
PREVIOUS_STACK_FILE="${RUN_DIR}/stack-before.tsv"
ROLLBACK_LOG_FILE="${RUN_DIR}/rollback.log"
RESTORE_REPORT_FILE="${RUN_DIR}/restore-verification.json"
MAINTENANCE_FLAG="${ROOT_DIR}/deploy/nginx/maintenance.flag"
ROLLBACK_ARMED=0
PREVIOUS_APP_VERSION=""
PREVIOUS_DEPLOY_VERSION=""
APP_VERSION=""
DEPLOY_VERSION=""

compose() {
  "${ROOT_DIR}/deploy/compose.sh" "$@"
}

require_command() {
  local command_name="$1"
  if ! command -v "${command_name}" >/dev/null 2>&1; then
    echo "Comando obrigatório não encontrado: ${command_name}"
    return 1
  fi
}

require_npm_12() {
  local npm_version npm_major
  npm_version="$(npm --version)"
  npm_major="${npm_version%%.*}"
  if [[ ! "${npm_major}" =~ ^[0-9]+$ || "${npm_major}" -lt 12 ]]; then
    echo "npm 12+ é obrigatório (encontrado: ${npm_version})"
    return 1
  fi
}

require_node_22() {
  local node_version node_major
  node_version="$(node --version)"
  node_major="${node_version#v}"
  node_major="${node_major%%.*}"
  if [[ ! "${node_major}" =~ ^[0-9]+$ || "${node_major}" -lt 22 ]]; then
    echo "Node.js 22+ é obrigatório (encontrado: ${node_version})"
    return 1
  fi
}

prepare_private_directory() {
  local directory="$1"
  if [[ "${directory}" != /* || "${directory}" == "/" || "${directory}" == "${ROOT_DIR}" ]]; then
    echo "Diretório operacional inseguro: ${directory}"
    return 1
  fi
  mkdir -p -- "${directory}"
  chmod 700 "${directory}"
}

wait_for_service() {
  local service="$1" container_id status="unknown"
  container_id="$(compose ps -q "${service}")"
  if [[ -z "${container_id}" ]]; then
    echo "Container do serviço ${service} não encontrado"
    return 1
  fi
  for _ in {1..30}; do
    status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "${container_id}")"
    if [[ "${status}" == "healthy" || "${status}" == "running" ]]; then return 0; fi
    sleep 2
  done
  echo "Serviço ${service} não ficou saudável a tempo (status: ${status})"
  return 1
}

ensure_service_running() {
  local service="$1"
  if [[ -z "$(compose ps -q "${service}")" ]]; then
    compose up -d --no-build "${service}"
  fi
  wait_for_service "${service}"
}

wait_for_url() {
  local label="$1" url="$2"
  for _ in {1..30}; do
    if curl --fail --silent --max-time 3 "${url}" >/dev/null 2>&1; then return 0; fi
    sleep 2
  done
  echo "${label} não ficou pronto a tempo"
  return 1
}

image_ref_for_service() {
  local prefix="${ATENDON_IMAGE_PREFIX:-atendon}"
  case "$1" in
    atendon-api) printf '%s/api:%s\n' "${prefix}" "${DEPLOY_VERSION}" ;;
    atendon-worker) printf '%s/worker:%s\n' "${prefix}" "${DEPLOY_VERSION}" ;;
    atendon-panel) printf '%s/panel:%s\n' "${prefix}" "${DEPLOY_VERSION}" ;;
    evolution-api) printf '%s\n' "atendon/evolution-api:v2.3.7-baileys-rc13" ;;
    *) echo "Serviço sem imagem gerenciada: $1" >&2; return 1 ;;
  esac
}

capture_stack_before() {
  local service container_id health image_id app_count=0
  : > "${PREVIOUS_STACK_FILE}"
  for service in "${ROLLBACK_SERVICES[@]}"; do
    container_id="$(compose ps -q "${service}")"
    [[ -n "${container_id}" ]] || continue
    health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "${container_id}")"
    if [[ "${health}" != "healthy" && "${health}" != "running" && "${ALLOW_UNHEALTHY_STACK_BEFORE_DEPLOY:-0}" != "1" ]]; then
      echo "Stack atual não está saudável: ${service}=${health}"
      return 1
    fi
    image_id="$(docker inspect -f '{{.Image}}' "${container_id}")"
    printf '%s\t%s\n' "${service}" "${image_id}" >> "${PREVIOUS_STACK_FILE}"
    if [[ " ${APP_SERVICES[*]} " == *" ${service} "* ]]; then app_count=$((app_count + 1)); fi
    if [[ "${service}" == "atendon-api" ]]; then
      read -r PREVIOUS_APP_VERSION PREVIOUS_DEPLOY_VERSION < <(
        docker inspect -f '{{json .Config.Env}}' "${container_id}" | node -e '
          const chunks=[];
          process.stdin.on("data",(chunk)=>chunks.push(chunk));
          process.stdin.on("end",()=>{
            const values=JSON.parse(Buffer.concat(chunks).toString("utf8"));
            const env=Object.fromEntries(values.map((entry)=>{const at=entry.indexOf("=");return [entry.slice(0,at),entry.slice(at+1)]}));
            console.log(env.APP_VERSION??"", env.DEPLOY_VERSION??"");
          });'
      )
    fi
  done
  chmod 600 "${PREVIOUS_STACK_FILE}"
  if [[ "${app_count}" -ne 0 && "${app_count}" -ne "${#APP_SERVICES[@]}" ]]; then
    echo "Stack de aplicação parcial antes do deploy: ${app_count}/${#APP_SERVICES[@]} serviços"
    return 1
  fi
}

validate_candidate_images() {
  local service image_ref
  for service in "${ROLLBACK_SERVICES[@]}"; do
    image_ref="$(image_ref_for_service "${service}")"
    docker image inspect "${image_ref}" >/dev/null
  done
  docker run --rm --entrypoint node "$(image_ref_for_service atendon-api)" \
    -e "const f=require('fs');f.accessSync('apps/backend/dist/server.js');f.accessSync('changelog.json')"
  docker run --rm --entrypoint node "$(image_ref_for_service atendon-worker)" \
    -e "require('fs').accessSync('apps/backend/dist/worker.js')"
  docker run --rm --entrypoint node "$(image_ref_for_service atendon-panel)" \
    -e "require('fs').accessSync('apps/panel/server.js')"
  docker run --rm --entrypoint npm "$(image_ref_for_service atendon-api)" --version \
    | awk -F. '$1 == 12 { valid=1 } END { exit valid ? 0 : 1 }'
}

enable_maintenance_page() {
  local temporary="${MAINTENANCE_FLAG}.$$"
  printf '%s\n' "${DEPLOY_VERSION:-deploy-in-progress}" > "${temporary}"
  chmod 644 "${temporary}"
  mv -- "${temporary}" "${MAINTENANCE_FLAG}"
}

disable_maintenance_page() {
  rm -f -- "${MAINTENANCE_FLAG}"
}

rollback_stack() {
  local reason="$1" service image_id current_ref
  local -a previous_services=() absent_services=()
  {
    echo "$(date -u +'%Y-%m-%dT%H:%M:%SZ') rollback de stack: ${reason}"
    echo "Schema e dados permanecem forward-only; nenhuma down migration ou restauração destrutiva foi executada."
  } >> "${ROLLBACK_LOG_FILE}"

  if [[ -n "${PREVIOUS_APP_VERSION}" ]]; then export APP_VERSION="${PREVIOUS_APP_VERSION}"; fi
  if [[ -n "${PREVIOUS_DEPLOY_VERSION}" ]]; then export DEPLOY_VERSION="${PREVIOUS_DEPLOY_VERSION}"; fi
  for service in "${ROLLBACK_SERVICES[@]}"; do
    if image_id="$(awk -F '\t' -v wanted="${service}" '$1 == wanted { print $2 }' "${PREVIOUS_STACK_FILE}")" && [[ -n "${image_id}" ]]; then
      current_ref="$(image_ref_for_service "${service}")"
      docker image tag "${image_id}" "${current_ref}"
      previous_services+=("${service}")
    else
      absent_services+=("${service}")
    fi
  done

  if [[ "${#previous_services[@]}" -gt 0 ]]; then
    compose up -d --no-deps --no-build --force-recreate --wait "${previous_services[@]}" || true
  fi
  if [[ "${#absent_services[@]}" -gt 0 ]]; then
    compose stop "${absent_services[@]}" >/dev/null 2>&1 || true
    compose rm -f -s "${absent_services[@]}" >/dev/null 2>&1 || true
  fi
}

deployment_failed() {
  local line="$1" status="$2"
  trap - ERR INT TERM
  set +e
  echo "Deploy falhou na linha ${line} (status ${status})"
  if [[ "${ROLLBACK_ARMED}" -eq 1 ]]; then rollback_stack "falha na linha ${line}, status ${status}"; fi
  disable_maintenance_page
  exit "${status}"
}

verify_version_endpoint() {
  local payload
  payload="$(curl --fail --silent --max-time 5 "http://127.0.0.1:${API_PORT:-3110}/version")"
  EXPECTED_APP_VERSION="${APP_VERSION}" EXPECTED_DEPLOY_VERSION="${DEPLOY_VERSION}" node -e '
    const chunks=[];
    process.stdin.on("data",(chunk)=>chunks.push(chunk));
    process.stdin.on("end",()=>{
      const payload=JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if(payload.version!==process.env.EXPECTED_APP_VERSION) throw new Error(`versão ativa ${payload.version} diverge de ${process.env.EXPECTED_APP_VERSION}`);
      if(payload.deployVersion!==process.env.EXPECTED_DEPLOY_VERSION) throw new Error(`deploy ativo ${payload.deployVersion} diverge de ${process.env.EXPECTED_DEPLOY_VERSION}`);
    });' <<< "${payload}"
}

initialize_deploy_version() {
  APP_VERSION="$(node -p "require('./package.json').version")"
  local source_commit
  source_commit="$(git rev-parse --short=12 HEAD 2>/dev/null || printf 'unknown')"
  DEPLOY_VERSION="${ATENDON_DEPLOY_VERSION:-v${APP_VERSION}-${source_commit}-${RUN_ID}}"
  export APP_VERSION DEPLOY_VERSION
}

run_versioning() {
  if [[ "${ATENDON_BUMP_VERSION:-0}" == "1" ]]; then
    echo "==> Atualizando changelog e versão por solicitação explícita"
    if [[ -f "${ROOT_DIR}/.env" ]]; then
      node --env-file="${ROOT_DIR}/.env" "${ROOT_DIR}/scripts/changelog-bump.mjs"
    else
      node "${ROOT_DIR}/scripts/changelog-bump.mjs"
    fi
    npm run version:sync-lock
  fi
  initialize_deploy_version
  echo "Versão da aplicação: ${APP_VERSION}"
  echo "Versão imutável do deploy: ${DEPLOY_VERSION}"
}

if [[ "${ATENDON_BUILD_FUNCTIONS_ONLY:-0}" == "1" ]]; then
  if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then exit 0; else return 0; fi
fi

trap 'deployment_failed ${LINENO} $?' ERR
trap 'deployment_failed ${LINENO} 130' INT
trap 'deployment_failed ${LINENO} 143' TERM

cd "${ROOT_DIR}"
for command_name in awk curl docker flock git node npm; do require_command "${command_name}"; done
require_node_22
require_npm_12
if ! docker compose version >/dev/null 2>&1; then
  echo "Docker Compose v2 não está disponível"
  exit 1
fi

exec 9>"${BUILD_LOCK}"
if ! flock -n 9; then
  echo "Outro deploy do AtendON já está em execução (${BUILD_LOCK})"
  exit 1
fi

prepare_private_directory "${RUN_DIR}"
prepare_private_directory "${BACKUP_DIR}"
initialize_deploy_version
capture_stack_before

NPM_CI_STAMP="${ROOT_DIR}/node_modules/.build-lockfile-stamp"
if [[ -f "${NPM_CI_STAMP}" ]] && cmp -s "${ROOT_DIR}/package-lock.json" "${NPM_CI_STAMP}"; then
  echo "==> Dependências já sincronizadas com package-lock.json, pulando npm ci"
else
  echo "==> Instalando dependências"
  npm ci --include=dev
  cp -- "${ROOT_DIR}/package-lock.json" "${NPM_CI_STAMP}"
fi

echo "==> Subindo PostgreSQL e Redis para os testes isolados"
for service in postgres redis; do ensure_service_running "${service}"; done
echo "==> Validando isolamento e aplicando migrations do banco de testes"
npm run test:db:check -w @atendon/backend
npm run migrate:test -w @atendon/backend
echo "==> Validando lint, tipos e testes"
npm run lint
npm run typecheck
npm test

echo "==> Build local do backend para o E2E"
NODE_ENV=production npm run build -w @atendon/backend
echo "==> Executando E2E gerenciado"
env -u PANEL_E2E_BACKEND_URL -u PANEL_E2E_BASE_URL -u PANEL_E2E_REUSE_EXISTING_SERVER npm run test:e2e

run_versioning
echo "==> Construindo imagens candidatas sem alterar o stack saudável"
if ! docker image inspect "$(image_ref_for_service evolution-api)" >/dev/null 2>&1; then
  echo "==> Imagem Evolution ausente; construindo a versão fixada"
  compose build evolution-api
fi
compose build "${APP_SERVICES[@]}"
echo "==> Validando conteúdo e toolchain das imagens candidatas"
validate_candidate_images

echo "==> Criando backup consistente do PostgreSQL"
NODE_ENV=production APP_VERSION="${APP_VERSION}" DEPLOY_VERSION="${DEPLOY_VERSION}" npm run backup:database -w @atendon/backend -- \
  --output-dir "${BACKUP_DIR}" \
  --pg-dump "${PG_DUMP_BIN:-${ROOT_DIR}/deploy/postgres/pg-dump-compose.sh}"
shopt -s nullglob
backup_manifests=("${BACKUP_DIR}"/*.manifest.json)
shopt -u nullglob
if [[ "${#backup_manifests[@]}" -ne 1 ]]; then
  echo "Esperado exatamente um manifesto de backup em ${BACKUP_DIR}; encontrados ${#backup_manifests[@]}"
  false
fi
BACKUP_MANIFEST="${backup_manifests[0]}"
RESTORE_DATABASE="atendon_restore_verify_$(node -e "console.log(require('node:crypto').randomUUID().replaceAll('-',''))")"
echo "==> Validando restore real no banco descartável ${RESTORE_DATABASE}"
NODE_ENV=production APP_VERSION="${APP_VERSION}" DEPLOY_VERSION="${DEPLOY_VERSION}" npm run restore:verify -w @atendon/backend -- \
  --manifest "${BACKUP_MANIFEST}" \
  --target-database "${RESTORE_DATABASE}" \
  --report-file "${RESTORE_REPORT_FILE}" \
  --cleanup \
  --confirm-drop "${RESTORE_DATABASE}" \
  --pg-restore "${PG_RESTORE_BIN:-${ROOT_DIR}/deploy/postgres/pg-restore-compose.sh}"

echo "==> Ativando manutenção para migrations e troca do stack"
enable_maintenance_page
echo "==> Aplicando migrations principais com credencial separada"
NODE_ENV=production APP_VERSION="${APP_VERSION}" DEPLOY_VERSION="${DEPLOY_VERSION}" npm run migrate -w @atendon/backend
echo "==> Executando provisionamento idempotente"
NODE_ENV=production APP_VERSION="${APP_VERSION}" DEPLOY_VERSION="${DEPLOY_VERSION}" npm run provision:tripz -w @atendon/backend
echo "==> Registrando snapshot de flags"
NODE_ENV=production APP_VERSION="${APP_VERSION}" DEPLOY_VERSION="${DEPLOY_VERSION}" npm run snapshot:deploy -w @atendon/backend

ROLLBACK_ARMED=1
echo "==> Reconciliando infraestrutura e Evolution"
for service in postgres redis evolution-postgres; do ensure_service_running "${service}"; done
compose up -d --no-build --wait evolution-api
echo "==> Trocando API, worker e painel pelas imagens validadas"
compose up -d --no-build --wait "${APP_SERVICES[@]}"
echo "==> Validando readiness, painel e versão publicada"
wait_for_url "API" "http://127.0.0.1:${API_PORT:-3110}/ready"
wait_for_url "Painel" "http://127.0.0.1:${PANEL_PORT:-3200}/login"
verify_version_endpoint
disable_maintenance_page

ROLLBACK_ARMED=0
echo "==> Deploy ${DEPLOY_VERSION} concluído"
echo "Estado operacional: ${RUN_DIR}"
echo "Backup validado: ${BACKUP_MANIFEST}"
