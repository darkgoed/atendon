#!/usr/bin/env bash

set -Eeuo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}/apps/panel"

exec node ../../node_modules/next/dist/bin/next start -H 127.0.0.1 -p 3200
