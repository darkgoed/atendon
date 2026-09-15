# AtendON Design System — contrato de implementação

> STATUS: fundação proposta, NÃO aplicada. A primeira tentativa de aplicar este
> contrato foi revertida em produção (ver "Lição da v1" abaixo). Os arquivos
> aqui descritos para `styles/` ainda não existem na base; o que está versionado
> hoje são apenas este contrato e os scripts de verificação em `scripts/ds-*`.

## Lição da v1 — leia antes de migrar qualquer tela

A v1 foi revertida porque a migração **apagou design existente em vez de
portá-lo**. Em `auth.css` (256 → 74 linhas) o split-screen do login, com hero
tipográfico de 66px, divisor vertical e eyebrow em mono, virou um card
centralizado genérico: `.login-intro` recebeu `display:none` incondicional e o
`h1` ficou no DOM medindo 0×0. `feedback.css` perdeu 50 linhas.

Duas regras nasceram disso:

1. **Repintar, não recompor.** Este contrato governa a LINGUAGEM visual — cor,
   tipografia, espaçamento, proporção, primitives, estados. A COMPOSIÇÃO de
   cada tela (colunas, hierarquia de blocos, presença de hero, split-screen)
   é parte do produto e se preserva. Se uma migração remove mais CSS do que
   adiciona, isso é sinal de apagamento: pare e porte o design.
2. **Densidade não é apagamento.** "Títulos moderados" vale para as telas
   densas de operação (tabelas, listas, painéis). Superfícies de marca — login,
   estados públicos, vazios de destaque — mantêm presença tipográfica. Use os
   dois registros da escala; não aplique o teto denso globalmente.

E o erro de verificação que deixou isso passar: contraste, paridade light/dark,
overflow e tokens foram todos medidos e reportados como "0 defeitos", mas
**nenhuma tela foi inspecionada visualmente**. Métrica limpa não é design bom.
Capture o original de cada tela ANTES de migrar, e compare antes/depois com
inspeção visual real antes de qualquer deploy.

## Escala tipográfica: dois registros

- **Denso** (operação): page title 19px, section 14px, body 13.5px, control 13px,
  label 12px, meta 11.5px, micro 11px.
- **Expressivo** (marca/superfícies públicas): mantém a escala original da tela
  — ex.: hero do login em `clamp(44px, 5.2vw, 76px)`. Não reduzir.


Fonte de verdade: `apps/panel/styles/tokens.css` (foundations + semantic tokens
+ aliases legados), `styles/base.css` (reset), `styles/components.css`
(primitives), `styles/shell.css` (sidebar/topbar/content/superfícies públicas).

Um único design system. DARK é o tema base; LIGHT re-declara **apenas** os
semantic tokens. Layout, spacing, hierarquia, dimensões, componentes e padrões
de interação são IDÊNTICOS nos dois temas.

## Regras invioláveis

1. **Zero cor hardcoded.** Nenhum `#hex`, `rgb()`, `hsl()`, nome de cor CSS ou
   utilitário de cor do Tailwind (`text-slate-500`, `bg-white`, `border-gray-200`)
   em CSS de domínio ou em componentes. Use sempre `var(--token)`.
   Exceção única: `color-mix(in srgb, var(--token) N%, transparent)`.
2. **Zero token legado em código novo.** Os aliases (`--faint`, `--accent-soft`,
   `--surface-2`, `--warn`, `--text-7`, `--font-size-caption`, …) existem só
   para a migração. Ao tocar um arquivo, converta-o para a camada semântica:
   `--bg --sidebar --surface --surface-elevated --surface-sunken --surface-hover
   --surface-active --surface-selected --border --border-subtle --border-strong
   --text --text-secondary --text-muted --text-disabled --text-inverse
   --primary --primary-hover --primary-active --primary-subtle --primary-border
   --primary-foreground --success/-subtle/-border --warning/… --danger/… --info/…`
3. **Hierarquia por ordem:** spacing → typography → background/surface → border.
   Borda só quando indispensável. Nunca `card → border → card → border`.
   Superfícies: `--bg` (app) → `--sidebar` → `--surface` (painel) →
   `--surface-elevated` (popover/dialog/menu).
4. **Nada de caixa-dentro-de-caixa.** Um painel não contém outro painel com
   borda. Separe seções internas com `--border-subtle` (1px) ou spacing.
5. **Proporções.** radius: `--radius-md` (7px) em inputs/botões,
   `--radius-lg` (9px) em painéis, `--radius-xl` (11px) em dialogs. Nunca
   16–24px. Controles: 32/36/40px via `--control-height{,-md,-lg}`.
   Ícones 16–18px (`--icon`, `--icon-lg`). Padding 12–20px.
6. **Sombras mínimas.** Só o que sai do fluxo: `--shadow-popover`,
   `--shadow-dialog`, `--shadow-drag`, `--shadow-sm`. Painéis e cards: nenhuma.
7. **Sem glassmorphism, sem gradiente decorativo, sem `backdrop-filter`.**
   Gradiente permitido apenas em `skeleton` (shimmer) e fade de scroll.
8. **Excesso de azul é proibido.** `--primary` (cobalto) só em: ação primária,
   item de nav ativo, foco, seleção, link. O resto é graphite neutro.
9. **Estados obrigatórios** em todo elemento interativo, nos dois temas:
   `default, hover, focus-visible, active, selected, disabled, loading, error`.
   Foco sempre via `box-shadow: var(--focus-ring)` — nunca `outline` custom,
   nunca `outline: none` sem substituto.
10. **Contraste WCAG AA:** texto normal ≥ 4.5:1, ≥ 18.66px bold / 24px ≥ 3:1.
    `--text-muted` já é AA sobre `--surface` nos dois temas — não escureça mais
    nem use `opacity` para criar texto secundário (use os tokens de texto).
11. **Densidade sem aperto.** Linha de tabela `--row-height` (38px), nav item
    28px, gap padrão 8–16px. Nada de `min-height` grande ou padding 24px+.
12. **Overflow e viewport.** Todo painel com conteúdo largo precisa de
    ancestral scrollável real (`overflow:auto`), não `overflow:hidden` seco.
    Popovers/dialogs: `max-width: min(Xpx, calc(100vw - 24px))` e
    `max-height: min(Ypx, calc(100dvh - 24px))`. Texto longo: `.truncate` ou
    `.clamp-2`. Nunca deixar conteúdo inalcançável.
13. **z-index só por token:** `--z-sticky --z-topbar --z-sidebar --z-drawer
    --z-popover --z-dialog --z-toast`.
14. **Ícones:** uma família só. O projeto usa `@phosphor-icons/react` com
    `weight="regular"` e tamanho 16–18. NÃO troque de biblioteca nem misture
    pesos (`fill`/`bold` só em dot/indicador minúsculo). Mantenha consistência.
15. **Motion:** só `--duration-fast|normal` com `--ease`. Transição apenas em
    `background-color, border-color, color, box-shadow, transform, opacity`.
    Nenhuma animação decorativa. `prefers-reduced-motion` já tratado em base.css.

## Primitives disponíveis (reutilize, não recrie)

`.panel .panel--elevated .panel--bare .card .cardtitle`
`.btn` + `.btn-primary|.btn.quiet(ghost)|.btn--outline|.btn.danger|.btn--danger-solid`
`.btn--sm .btn--lg .icon-button .icon-button--sm .icon-button--lg .segmented`
`.input .input--sm .field .field--error .field__error .field__hint .search-field .switch`
`.badge .badge--info|success|warning|danger|primary|outline|pill .dot .kbd`
`.table-wrap` + `table/thead th/td` (já estilizados: header uppercase micro,
linhas densas, hover, `[aria-selected]`, `.is-numeric`, `th[aria-sort]`)
`.empty .error .loading-state .skeleton .progress`
`.overlay-backdrop .popover .menu .menu__item .menu__separator .menu__label .tooltip`
`.stack .cluster .spacer .divider .toolbar .toolbar--sticky .ui-section`
Tipografia: `.type-page-title .type-section-title .type-body .type-secondary
.type-label .type-meta .type-muted .type-overline .type-metric .truncate .clamp-2`

Se um domínio precisa de algo que não existe, **primeiro** verifique se um
primitive resolve; só então crie uma classe de domínio — tokenizada e sem
duplicar um primitive.

## Verificação antes de entregar

```bash
cd apps/panel
# 1. sem cor hardcoded no escopo tocado
grep -rInoE '#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(' <arquivos>
# 2. sem utilitário de cor Tailwind
grep -rInoE '\b(bg|text|border|ring|from|to|via)-(white|black|slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-?[0-9]*\b' <arquivos>
# 3. gates reais
npx tsc --noEmit && npx eslint . --max-warnings=0 && npx next build
```
