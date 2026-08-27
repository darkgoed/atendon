#!/usr/bin/env bash
# Validação independente das entregas — rodada comments.md 2026-08-27.
# O orquestrador roda ISTO; não confia no auto-relato dos agentes.
set -u
ROOT=/var/www/apps/atendon
PANEL=$ROOT/apps/panel
BACK=$ROOT/apps/backend
export DATABASE_URL=${DATABASE_URL:-postgres://u:p@127.0.0.1:1/db}
export PANEL_SEED_PASSWORD=${PANEL_SEED_PASSWORD:-abcd1234}

line() { printf '\n===== %s =====\n' "$1"; }

line "PANEL typecheck"
(cd "$PANEL" && npx tsc --noEmit -p tsconfig.json 2>&1 | tail -25; echo "exit=${PIPESTATUS[0]}")

line "BACKEND typecheck"
(cd "$BACK" && npx tsc --noEmit 2>&1 | tail -25; echo "exit=${PIPESTATUS[0]}")

line "PANEL vitest"
(cd "$PANEL" && npx vitest run 2>&1 | tail -30; echo "exit=${PIPESTATUS[0]}")

line "PANEL eslint (o build usa --max-warnings=0)"
(cd "$PANEL" && npx eslint . --max-warnings=0 2>&1 | tail -30; echo "exit=${PIPESTATUS[0]}")

line "BACKEND vitest (falhas de ECONNREFUSED sao preexistentes)"
(cd "$BACK" && npx vitest run 2>&1 | tail -40; echo "exit=${PIPESTATUS[0]}")

line "N3 fonte: nenhuma referencia a IBM Plex Mono"
grep -rn "IBM Plex Mono" "$PANEL" --include=*.css --include=*.tsx --include=*.ts 2>/dev/null | grep -v node_modules | head -10 || true
echo "ocorrencias=$(grep -rn 'IBM Plex Mono' "$PANEL" --include=*.css --include=*.tsx --include=*.ts 2>/dev/null | grep -vc node_modules)"

line "N8 hover: nenhum title= nos arquivos da agenda"
grep -n "title=" "$PANEL"/app/agenda/*.tsx || echo "OK: nenhum title="

line "N1 follow-ups: fora do menu lateral"
grep -n "follow-ups" "$PANEL"/components/shell.tsx || echo "OK: ausente do shell"

line "N5 pipeline: botao Lista deixou de ser span inerte"
grep -n "aria-disabled=\"true\"" "$PANEL"/app/leads/pipeline/page.tsx || echo "OK: sem span inerte"

line "GUARDRAIL: nenhuma migration destrutiva em src/db/migrations"
grep -rniE "drop (table|column)|truncate " "$BACK"/src/db/migrations/*.sql 2>/dev/null | head -10 || echo "OK: nenhuma destrutiva"
echo "ultimas migrations:"; ls "$BACK"/src/db/migrations/ | tail -5

line "GUARDRAIL: globals.css com chaves balanceadas"
python3 - <<'PY'
p='/var/www/apps/atendon/apps/panel/app/globals.css'
s=open(p,encoding='utf-8').read()
print('abre=',s.count('{'),'fecha=',s.count('}'),'balanceado=',s.count('{')==s.count('}'),'linhas=',s.count(chr(10))+1)
PY
