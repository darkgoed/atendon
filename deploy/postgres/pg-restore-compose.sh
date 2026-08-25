#!/usr/bin/env bash

set -Eeuo pipefail
ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"

exec docker compose -f "${ROOT_DIR}/docker-compose.yml" exec -T \
  -e PGHOST=127.0.0.1 \
  -e PGPORT=5432 \
  -e PGDATABASE \
  -e PGUSER \
  -e PGPASSWORD \
  postgres pg_restore "$@"
