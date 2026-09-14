#!/usr/bin/env bash
# Conformidade estática com o design system do AtendON.
# Uso: bash scripts/ds-grep.sh   (a partir de apps/panel)
set -uo pipefail
cd "$(dirname "$0")/.."

SCOPE="app components styles lib"
fail=0

section() { printf '\n=== %s ===\n' "$1"; }

section "1. Cores hardcoded (hex/rgb/hsl) fora de tokens.css"
hits=$(grep -rInoE '#[0-9a-fA-F]{3,8}\b|\brgba?\([0-9]|\bhsla?\(' $SCOPE \
  --include='*.css' --include='*.tsx' --include='*.ts' \
  | grep -v '^styles/tokens.css' \
  | grep -v 'rgb(0 0 0' \
  | grep -v '^app/manifest.ts' \
  | grep -v '^components/settings-colors.ts' || true)
# Exceções legítimas: manifest.ts (PWA theme_color, não aceita var()) e
# settings-colors.ts (catálogo de cores ESCOLHÍVEIS pelo usuário = dado, não chrome).
if [ -n "$hits" ]; then echo "$hits"; fail=1; else echo "ok"; fi

section "2. Utilitários de cor do Tailwind"
hits=$(grep -rInoE '\b(bg|text|border|ring|divide|from|to|via)-(white|black|slate|gray|grey|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)(-[0-9]{2,3})?\b' $SCOPE || true)
if [ -n "$hits" ]; then echo "$hits"; fail=1; else echo "ok"; fi

section "3. Tokens legados remanescentes (devem chegar a zero)"
LEGACY='--app|--surface-2|--surface-3|--panel|--panel-secondary|--panel-raised|--side|--topbar|--sticky|--scroll-surface|--hover|--active|--bubble|--input|--dialog|--tooltip|--toast|--disabled-bg|--border-2|--border-3|--border-hover|--strong|--divider-dash|--heading|--body|--muted|--faint|--faint-text|--text-[2-9]|--primary-fg|--primary-text|--primary-accent|--accent|--accent-fg|--accent-soft|--accent-strong|--accent-bg|--accent-bg-strong|--accent-surface|--accent-dim|--primary-tint-bg|--primary-tint-border|--border-ai|--bubble-ai|--ai-bg|--ok|--ok-bg|--ok-border|--warn|--warn-bg|--warn-border|--warn-muted|--overdue|--urgent|--cat-demo|--cat-follow|--cat-referral|--font-size-body|--font-size-caption|--font-size-label|--font-size-control|--font-size-title|--font-caption|--text-xs|--text-md|--text-2xl'
grep -rhoE "var\((${LEGACY})\)" $SCOPE --include='*.css' --include='*.tsx' \
  | sed 's/var(//;s/)//' | sort | uniq -c | sort -rn | head -40
echo "--- por arquivo ---"
grep -rlE "var\((${LEGACY})\)" $SCOPE --include='*.css' --include='*.tsx' \
  | grep -v '^styles/tokens.css' | sort || echo "nenhum"

section "4. Radius fora da escala (>=12px literal)"
hits=$(grep -rInoE 'border-radius:\s*(1[2-9]|[2-9][0-9])px' $SCOPE || true)
if [ -n "$hits" ]; then echo "$hits"; fail=1; else echo "ok"; fi

section "5. Proibidos: glassmorphism / sombra pesada / !important"
# !important é aceito apenas dentro de prefers-reduced-motion (override de motion).
hits=$(grep -rInE 'backdrop-filter|filter:\s*blur|box-shadow:[^;]*[0-9]{2,}px [0-9]{2,}px [0-9]{2,}px|!important' $SCOPE --include='*.css' \
  | grep -vE 'reduced-motion|scroll-behavior: auto|animation-duration|animation-iteration-count|transition-duration' || true)
if [ -n "$hits" ]; then echo "$hits"; fail=1; else echo "ok"; fi

section "6. z-index literal (deve usar token)"
hits=$(grep -rInoE 'z-index:\s*[0-9]+' $SCOPE --include='*.css' | grep -vE 'z-index:\s*(0|1|-1);?$' || true)
if [ -n "$hits" ]; then echo "$hits"; fail=1; else echo "ok"; fi

section "7. outline:none sem substituto de foco"
# base.css define o padrão global de foco (:focus-visible com box-shadow);
# composerTextarea tem regra :focus-visible própria na linha seguinte.
hits=$(grep -rIn 'outline:\s*none' $SCOPE --include='*.css' | grep -v 'box-shadow' \
  | grep -v '^styles/base.css' | grep -v 'composerTextarea' || true)
if [ -n "$hits" ]; then echo "$hits (confira se há box-shadow de foco na mesma regra)"; else echo "ok"; fi

printf '\n'
[ "$fail" = 0 ] && echo "RESULTADO: conformidade estática OK" || echo "RESULTADO: há violações acima"
exit 0
