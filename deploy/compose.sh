#!/usr/bin/env bash

set -Eeuo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_ARGS=(compose -f "${ROOT_DIR}/docker-compose.yml")

if [[ -f "${ROOT_DIR}/.env" ]]; then
  COMPOSE_ARGS+=(--env-file "${ROOT_DIR}/.env")
fi
if [[ -f "${ROOT_DIR}/.env.migration" ]]; then
  COMPOSE_ARGS+=(--env-file "${ROOT_DIR}/.env.migration")
fi

# Without an explicit project name, Compose derives one from the working
# directory ("atendon"). Coolify deploys this same compose file under its
# own project name (the application UUID), so any operator invocation of
# this wrapper — backups, restores, ad-hoc exec — would silently target a
# different, nonexistent "atendon" project instead of the live stack.
#
# Detect the actual running project from container labels and pin it,
# unless the caller already set COMPOSE_PROJECT_NAME explicitly. If zero or
# more than one distinct project is currently running this compose file's
# services, do not guess: fall back to Compose's default resolution so the
# command fails loudly instead of acting on the wrong stack.
if [[ -z "${COMPOSE_PROJECT_NAME:-}" ]]; then
  running_projects="$(docker ps --filter "label=com.docker.compose.service=atendon-api" --format '{{.Label "com.docker.compose.project"}}' 2>/dev/null | sort -u || true)"
  project_count="$(printf '%s\n' "${running_projects}" | sed '/^$/d' | wc -l | tr -d ' ')"
  if [[ "${project_count}" == "1" ]]; then
    detected_project="$(printf '%s\n' "${running_projects}" | sed '/^$/d')"
    COMPOSE_ARGS=(compose --project-name "${detected_project}" "${COMPOSE_ARGS[@]:1}")
  fi
fi

exec docker "${COMPOSE_ARGS[@]}" "$@"
