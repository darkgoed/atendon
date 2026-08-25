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

exec docker "${COMPOSE_ARGS[@]}" "$@"
