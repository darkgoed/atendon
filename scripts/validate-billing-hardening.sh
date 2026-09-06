#!/usr/bin/env bash
# Validação da rodada de hardening comercial/billing do AtendON.
# Rode a partir de /var/www/apps/atendon. Não confia em relatório de agente:
# mede typecheck, lint, suíte completa e invariantes por grep.
set -u
cd "$(dirname "$0")/.." || exit 1
OUT=/tmp/atendon-billing/validate
mkdir -p "$OUT"
fail=0

echo "== 1. typecheck =="
npm run typecheck > "$OUT/typecheck.log" 2>&1
echo "   exit=$? (0 esperado)"; grep -c "error TS" "$OUT/typecheck.log" | sed 's/^/   erros TS: /'

echo "== 2. lint (mesma severidade do build) =="
npx eslint apps/backend apps/panel --max-warnings=0 > "$OUT/lint.log" 2>&1
echo "   exit=$?"

echo "== 3. migrations em banco limpo + idempotência =="
npm run test:db:recreate -w @atendon/backend > "$OUT/dbrecreate.log" 2>&1
npm run migrate:test -w @atendon/backend > "$OUT/migrate1.log" 2>&1
echo "   1a aplicação exit=$?"
npm run migrate:test -w @atendon/backend > "$OUT/migrate2.log" 2>&1
echo "   2a aplicação (idempotência) exit=$?"

echo "== 4. suíte backend completa =="
npm test -w @atendon/backend > "$OUT/backend.log" 2>&1
grep -E "^ *(Test Files|Tests) " "$OUT/backend.log" | tail -2

echo "== 5. suíte painel completa =="
npm test -w @atendon/panel > "$OUT/panel.log" 2>&1
grep -E "^ *(Test Files|Tests) " "$OUT/panel.log" | tail -2

echo "== 6. diff de falhas contra o baseline =="
grep -E "^ *FAIL" "$OUT/backend.log" | sed 's/[0-9]\+ms//' | sort -u > "$OUT/after-backend.txt"
grep -E "^ *FAIL" "$OUT/panel.log"   | sed 's/[0-9]\+ms//' | sort -u > "$OUT/after-panel.txt"
echo "   -- regressões backend (falham agora e NÃO no baseline):"
comm -13 /tmp/atendon-billing/baseline-backend-fails.txt "$OUT/after-backend.txt" | sed 's/^/     /'
echo "   -- regressões painel:"
comm -13 /tmp/atendon-billing/baseline-panel-fails.txt "$OUT/after-panel.txt" | sed 's/^/     /'

echo "== 7. invariantes (grep) =="
echo -n "   getProvider ainda instancia stripe/pagbank? "
grep -qE 'case "(stripe|pagbank)"' apps/backend/src/billing/providers/registry.ts && { echo "SIM (FALHA)"; fail=1; } || echo "nao"
echo -n "   homologação é allowlist? "
grep -q "HOMOLOGATED_PROVIDER_CODES" apps/backend/src/billing/providers/homologation.ts && echo "sim" || { echo "NAO (FALHA)"; fail=1; }
echo -n "   job de dunning agendado no worker? "
grep -qi "dunning" apps/backend/src/worker.ts && echo "sim" || { echo "NAO (FALHA: modulo inerte)"; fail=1; }
echo -n "   invoices.ts ainda grava kind='usage' fixo? "
grep -q "'usage', \$3\|,'usage'," apps/backend/src/billing/invoices.ts && echo "SIM (verificar)" || echo "nao"
echo "   modulos novos sem importador (codigo inerte):"
for m in dunning ledger coupons proration fraud-signals homologation mercadopago-reconciliation; do
  f="apps/backend/src/billing/$m.ts"
  [ -f "$f" ] || continue
  n=$(grep -rl "billing/$m.js\|\./$m.js" apps/backend/src --include=*.ts | grep -v "$f" | wc -l)
  [ "$n" -eq 0 ] && { echo "     $m -> INERTE (0 importadores)"; fail=1; } || echo "     $m -> $n importador(es)"
done

echo "== 8. contagem de testes (cresceu?) =="
echo -n "   baseline backend: 1416 testes | agora: "
grep -E "^ *Tests " "$OUT/backend.log" | tail -1

echo
echo "RESULTADO: fail=$fail (0 = invariantes ok; confira as regressões acima)"
exit $fail
