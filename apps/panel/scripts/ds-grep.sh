#!/usr/bin/env bash
# Conformidade estática com o design system do AtendON.
# Uso: bash scripts/ds-grep.sh   (a partir de apps/panel)
#
# Um run limpo tem significado: as exceções legítimas estão codificadas aqui
# (ver comentários por seção), então qualquer hit é dívida real.
set -uo pipefail
cd "$(dirname "$0")/.."

SCOPE="app components styles lib"
fail=0

section() { printf '\n=== %s ===\n' "$1"; }

section "1. Cores hardcoded (hex/rgb/hsl) fora de tokens.css"
# Exceções legítimas:
#  - styles/tokens.css: é onde a paleta é DEFINIDA.
#  - app/manifest.ts: PWA theme_color/background_color são lidos pelo SO e não
#    aceitam var(); mantidos em sincronia manual com --bg do tema dark.
#  - components/settings-colors.ts: catálogo de cores ESCOLHÍVEIS pelo usuário
#    (etiquetas, agenda) = DADO, não chrome. Entra no CSS por custom property.
#  - rgb(0 0 0 / …) nas sombras de tokens.css: sombra é preto com alfa por
#    definição; não há token de cor para ela.
hits=$(grep -rInoE '#[0-9a-fA-F]{3,8}\b|\brgba?\([0-9]|\bhsla?\(' $SCOPE \
  --include='*.css' --include='*.tsx' --include='*.ts' \
  | grep -v '^styles/tokens.css' \
  | grep -v 'rgb(0 0 0' \
  | grep -v '^app/manifest.ts' \
  | grep -v '^components/settings-colors.ts' || true)
if [ -n "$hits" ]; then echo "$hits"; fail=1; else echo "ok"; fi

section "2. Utilitários de cor do Tailwind"
hits=$(grep -rInoE '\b(bg|text|border|ring|divide|from|to|via)-(white|black|slate|gray|grey|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)(-[0-9]{2,3})?\b' $SCOPE || true)
if [ -n "$hits" ]; then echo "$hits"; fail=1; else echo "ok"; fi

section "3. Tokens legados remanescentes (devem chegar a zero)"
# Vocabulário legado = nomes que a camada de aliases mapeava durante a migração.
# NÃO inclui tokens semânticos legítimos do sistema atual, como --primary-text
# (marca como texto, AA), --success-text/--warning-text/--danger-text/--info-text,
# --text-secondary/--text-muted/--text-subtle ou --cat-N-*.
LEGACY='--app|--surface-2|--surface-3|--panel|--panel-secondary|--panel-raised|--side|--topbar|--sticky|--scroll-surface|--hover|--active|--bubble|--input|--dialog|--tooltip|--toast|--disabled-bg|--border-2|--border-3|--border-hover|--strong|--divider-dash|--divider-dash-hover|--heading|--body|--muted|--faint|--faint-text|--text-[2-9]|--primary-fg|--primary-accent|--accent|--accent-fg|--accent-soft|--accent-strong|--accent-bg|--accent-bg-strong|--accent-surface|--accent-dim|--primary-tint-bg|--primary-tint-border|--border-ai|--bubble-ai|--ai-bg|--ok|--ok-bg|--ok-border|--warn|--warn-bg|--warn-border|--warn-muted|--danger-bg|--info-bg|--overdue|--urgent|--cat-demo|--cat-follow|--cat-referral|--font-size-body|--font-size-body-lg|--font-size-caption|--font-size-label|--font-size-control|--font-size-title|--font-caption|--text-xs|--text-md|--text-2xl|--ring|--today-head-bg|--today-body-bg|--appointment-color'
counts=$(grep -rhoE "var\((${LEGACY})\)" $SCOPE --include='*.css' --include='*.tsx' --include='*.ts' \
  | sed 's/var(//;s/)//' | sort | uniq -c | sort -rn || true)
files=$(grep -rlE "var\((${LEGACY})\)" $SCOPE --include='*.css' --include='*.tsx' --include='*.ts' \
  | grep -v '^styles/tokens.css' | sort || true)
if [ -n "$files" ]; then
  echo "$counts"; echo "--- por arquivo ---"; echo "$files"; fail=1
else
  echo "ok"
fi

section "4. Radius fora da escala (>=12px literal)"
hits=$(grep -rInoE 'border-radius:\s*(1[2-9]|[2-9][0-9])px' $SCOPE || true)
if [ -n "$hits" ]; then echo "$hits"; fail=1; else echo "ok"; fi

section "5. Proibidos: glassmorphism / sombra pesada / !important"
# !important é aceito apenas dentro de prefers-reduced-motion (esse bloco existe
# precisamente para sobrepor tudo).
hits=$(grep -rInE 'backdrop-filter|filter:\s*blur|box-shadow:[^;]*[0-9]{2,}px [0-9]{2,}px [0-9]{2,}px|!important' $SCOPE --include='*.css' \
  | grep -vE 'reduced-motion|scroll-behavior: auto|animation-duration|animation-iteration-count|transition-duration' || true)
if [ -n "$hits" ]; then echo "$hits"; fail=1; else echo "ok"; fi

section "6. z-index literal (deve usar token)"
# 0/1/2/-1 são ordenação local dentro de um stacking context, não camada global.
hits=$(grep -rInoE 'z-index:\s*-?[0-9]+' $SCOPE --include='*.css' | grep -vE 'z-index:\s*(0|1|2|-1)$' || true)
if [ -n "$hits" ]; then echo "$hits"; fail=1; else echo "ok"; fi

section "7. outline:none sem substituto de foco"
# base.css define o padrão global (:focus{outline:none} + :focus-visible{box-shadow}),
# que é o PADRÃO do design system, não uma violação.
hits=$(grep -rIn 'outline:\s*none' $SCOPE --include='*.css' | grep -v 'box-shadow' \
  | grep -v '^styles/base.css' || true)
if [ -n "$hits" ]; then echo "$hits (confira se há box-shadow de foco na mesma regra)"; fail=1; else echo "ok"; fi

section "8. Regra de shell/primitive fora do seu arquivo"
# Cada domínio é dono do seu arquivo; shell e primitives têm dono único.
# Exceção legítima: `.content:has(> .<dominio>-page)` / `.shell--fit .content:has(…)`
# — é o domínio declarando que ELE ocupa a tela inteira (flush), escopado pelo
# seu próprio seletor. O que é proibido é redefinir o shell incondicionalmente.
hits=$(grep -rInE '^\s*\.(sidebar|topbar|nav|brand|pagehead|account-card|palette-trigger)\b|^\s*\.(shell|content)[^:]*\{' styles/domains/ \
  | grep -v ':has(' || true)
if [ -n "$hits" ]; then echo "$hits"; fail=1; else echo "ok"; fi

section "9. :global NÃO-PURO em CSS module (erro de build que tsc/lint não pegam)"
# `.local :global(.x)` é PURO e válido (o seletor começa por uma classe local).
# O que quebra o webpack é `:global` no início do seletor, sem âncora local.
hits=$(grep -rInE '^\s*:global|^\s*[,>+~]?\s*:global\(' --include='*.module.css' app components || true)
if [ -n "$hits" ]; then echo "$hits"; fail=1; else echo "ok"; fi

printf '\n'
[ "$fail" = 0 ] && echo "RESULTADO: conformidade estática OK" || echo "RESULTADO: há violações acima"
exit 0
