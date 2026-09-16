# AtendON Design System — contrato de implementação

> STATUS: **aplicado**. Este arquivo é a fonte de verdade para qualquer mudança
> visual no painel. Se uma tela discorda dele, a tela está errada.

Fonte de verdade em código:

| Camada | Arquivo | Dono |
| --- | --- | --- |
| Tokens (foundations + semantic + aliases) | `styles/tokens.css` | ninguém edita sem revisar todo o produto |
| Reset e elementos base | `styles/base.css` | idem |
| Primitives (catálogo) | `styles/components.css` | idem |
| Shell (sidebar/topbar/content/públicas) | `styles/shell.css` | idem |
| Primitives React (Radix + variantes) | `components/ui/*` | idem |
| Domínios | `styles/domains/<dominio>.css` | um dono por arquivo |

Um único design system. **LIGHT** é declarado em `:root`; **DARK** re-declara
*apenas* os semantic tokens em `:root[data-theme="dark"]`. Layout, spacing,
hierarquia, dimensões, componentes e padrões de interação são **idênticos** nos
dois temas — só os valores de cor mudam. Qualquer seletor `[data-theme]` que
altere tamanho, radius, padding ou estrutura é um bug.

## Infraestrutura de componentes

**Radix UI headless + o CSS deste sistema.** Radix entrega comportamento
(foco preso, teclado, portal, `aria-*`, colisão com viewport); o design system
entrega aparência. Nunca reimplemente foco, Escape, portal ou roving tabindex à
mão — use o primitive.

`class-variance-authority` define as variantes tipadas dos primitives;
`tailwind-merge` (via `lib/cn.ts` → `cn()`) resolve conflito de utilitários para
que um `className` da chamada sobreponha o default em vez de duplicá-lo.

**Não existe camada de nomes shadcn** (`--muted`, `--accent`, `--input`,
`--ring`, `--primary`): esses nomes já significam outra coisa no vocabulário
herdado do AtendON (`--muted` é *texto* secundário, usado 140×) e a colisão
repintaria texto como superfície. Os componentes consomem os tokens semânticos
do AtendON diretamente.

## Regras invioláveis

1. **Zero cor hardcoded.** Nenhum `#hex`, `rgb()`, `hsl()`, nome de cor CSS nem
   utilitário de cor do Tailwind (`text-slate-500`, `bg-white`) em CSS de domínio
   ou em componente. Use `var(--token)`.
   Exceções, só estas: `color-mix(in srgb, var(--token) N%, transparent)`;
   `app/manifest.ts` (PWA `theme_color` é lido pelo SO e não aceita `var()`);
   `components/settings-colors.ts` (catálogo de cores **escolhíveis pelo
   usuário** = dado, não chrome — entra no CSS por custom property).
2. **Zero token legado em código novo.** Os aliases em `tokens.css`
   (`--faint`, `--accent-soft`, `--surface-2`, `--warn`, `--text-7`,
   `--font-size-caption`, …) existem só para a migração. Ao tocar um arquivo,
   converta-o para a camada semântica.
3. **Hierarquia por ordem: spacing → typography → surface → border.** Borda é o
   último recurso. Nunca `card → border → card → border`.
   Superfícies: `--bg` → `--sidebar` → `--surface` → `--surface-elevated`,
   mais `--surface-sunken` e o trio `--surface-hover/-active/-selected`.
4. **Nada de caixa-dentro-de-caixa.** Um painel não contém outro painel com
   borda. Seções internas: `.panel__section` (divisor de 1px) ou spacing.
5. **Proporções.** Radius: `--radius-md` (7px) em inputs/botões, `--radius-lg`
   (9px) em painéis, `--radius-xl` (11px) em dialogs. Nunca 16–24px.
   Controles: 28/32/36/40/44px via `--control-height-{sm,,md,lg,touch}`.
   Ícones 16–18px. Padding de painel 16–20px.
6. **Sombras só para o que sai do fluxo:** `--shadow-popover`, `--shadow-dialog`,
   `--shadow-drag`, `--shadow-sm`. Painéis, cards e linhas: nenhuma.
7. **Sem glassmorphism, sem gradiente decorativo, sem `backdrop-filter`.**
   Gradiente permitido apenas em `.skeleton` (shimmer) e fade de scroll.
8. **Azul com parcimônia.** `--primary` só em: ação primária, item de nav ativo,
   foco, seleção, link e indicador. Todo o resto é neutro.
9. **Estados obrigatórios** em todo interativo, nos dois temas: `default, hover,
   focus-visible, active, selected, disabled, loading, error`. Foco sempre por
   `box-shadow: var(--focus-ring)`; `base.css` já define o par
   `:focus { outline: none }` + `:focus-visible { box-shadow }` — não recrie.
10. **Contraste WCAG AA** ≥ 4.5:1 (≥3:1 para ≥24px ou ≥18.66px bold), medido
    contra **todas** as superfícies onde o texto pode pousar, não só `--surface`.
    Nunca crie texto secundário com `opacity` (compõe contra a superfície e
    quebra o contraste) — use os tokens de texto. Para cor de status **como
    texto** use `--{status}-text`; `--{status}` puro é fill/borda/indicador.
11. **Densidade sem aperto.** Linha de tabela `--row-height` (38px), item de nav
    30px, gap padrão 8–16px.
12. **Overflow e viewport.** Painel com conteúdo largo precisa de ancestral
    scrollável real. Popover/dialog: `min(Xpx, calc(100vw - var(--space-6)))` e
    `max-height: min(Ydvh, calc(100dvh - var(--space-8)))`. Texto longo:
    `.truncate` ou `.clamp-2`. Nunca conteúdo inalcançável.
13. **z-index só por token:** `--z-sticky --z-topbar --z-sidebar --z-drawer
    --z-popover --z-dialog --z-toast`.
14. **Ícones:** `@phosphor-icons/react`, `weight="regular"`, 16–18px. Não troque
    de biblioteca nem misture pesos (`fill`/`bold` só em dot/indicador mínimo).
15. **Motion:** só `--duration-fast|normal` com `--ease`, e só em
    `background-color, border-color, color, box-shadow, transform, opacity`.
    `prefers-reduced-motion` já tratado em `base.css`.

## Dois registros tipográficos

- **Denso** (operação — tabelas, listas, painéis): page title 20px, section 14px,
  body 13.5px, control 13px, label 12px, meta 11.5px, micro 11px.
- **Expressivo** (marca — login, estados públicos, 403, convite, meet):
  `--text-hero` / `--text-hero-sub` mantêm presença tipográfica.
  **Não aplique o teto denso globalmente**: achatar o login foi exatamente o
  erro que reverteu a v1 deste refactor.

## Primitives disponíveis (reutilize, não recrie)

CSS:
`.panel .panel--elevated|--sunken|--bare|--pad .panel__header|__body|__footer|__section`
`.card .card--sunken .cardtitle .divider .divider--strong`
`.btn` + `.primary|.quiet|.danger|.btn--outline|.btn--danger-solid|.btn--sm|.btn--lg|.btn--block`
`.icon-button .icon-button--sm|--md|--lg .segmented`
`.input .input--sm .field .field--error .field__error .field__hint .search-field .switch .checkbox`
`.badge .badge--neutral|primary|info|success|warning|danger|outline|pill .dot .kbd .progress .spinner`
`.table-wrap` + `table/thead th/tbody td` (header micro uppercase, linhas 38px,
hover, `[aria-selected]`, `.is-numeric`, `th[aria-sort]`)
`.empty .error .loading-state .skeleton`
`.overlay-backdrop .popover .menu .menu__item|__separator|__label .dialog .dialog__header|__body|__footer .tooltip`
`.stack .cluster .spacer .toolbar .toolbar--sticky .ui-section .grid2 .grid3 .grid4 .grid-main`
Tipografia: `.type-page-title .type-section-title .type-body .type-secondary
.type-label .type-meta .type-muted .type-overline .type-metric .type-hero
.truncate .clamp-2 .clamp-3 .tabular`

React (`@/components/ui`):
`Button IconButton Segmented · Badge Dot · Panel PanelHeader PanelBody
PanelFooter PanelSection Card Section Divider · Field Input Select Textarea ·
Stack Cluster PageHeader · EmptyState ErrorState LoadingState Progress Spinner
Skeleton · Table TableScroll · Dialog DialogClose · Menu MenuItem MenuLabel
MenuSeparator Tooltip TooltipProvider Switch Checkbox Tabs TabsList TabsTrigger
TabsContent ToggleGroup ToggleGroupItem`

Se um domínio precisa de algo que não existe: **primeiro** verifique se um
primitive resolve; só então crie classe de domínio — tokenizada, sem duplicar
primitive e no arquivo do próprio domínio.

## Propriedade de arquivo

Cada domínio é dono exclusivo do seu `styles/domains/*.css`. É proibido:
- escrever regra de shell (`.sidebar .topbar .content .pagehead`) fora de
  `shell.css`;
- escrever regra de primitive (`.btn .input .badge .card table`) fora de
  `components.css`;
- estilizar classes de outro domínio.

Isto não é burocracia: antes deste refactor as regras do shell mobile viviam em
`domains/auth.css`, as de admin em `domains/pipeline.css` e as de settings em
`domains/conversations.css` — o shell tinha que ser editado em dois lugares e
ninguém sabia quem era dono de quê.

`:global(...)` dentro de um `*.module.css` é **erro de build** no webpack
("selector is not pure"), e nem `tsc` nem o lint pegam. Regras globais vão para
o stylesheet de domínio.

## Verificação antes de entregar

```bash
cd apps/panel
bash scripts/ds-grep.sh                 # conformidade estática (9 seções)
node scripts/ds-orphan-classes.mjs      # classe no markup sem regra + APAGAMENTO vs HEAD
node scripts/ds-migrate-tokens.mjs --dry # deve reportar 0 tokens legados pendentes
npx tsc --noEmit
npx eslint . --max-warnings=0
npx next build                          # único lugar que pega :global impuro em module.css
npx vitest run

# runtime, com o servidor de produção rodando:
PLAYWRIGHT_BROWSERS_PATH=$HOME/.cache/ms-playwright node scripts/ds-audit.mjs http://127.0.0.1:3200
PLAYWRIGHT_BROWSERS_PATH=$HOME/.cache/ms-playwright node scripts/ds-theme-parity.mjs http://127.0.0.1:3200
```

### O gate que faltava na v1: `ds-orphan-classes.mjs`

A v1 passou em **todos** os gates (tsc, lint, build, contraste, paridade) e ainda
assim apagou o login: `.login-intro` recebeu `display:none` e o `h1` ficou 0×0.
Nenhum instrumento olhava a pergunta certa. Este script olha três:

1. **Órfãos** — classe citada em `className` que NENHUM CSS define. É um elemento
   sem estilo, e nenhum outro gate vê isso.
1b. **Famílias concatenadas** — `agenda-appointment--${status}` monta o nome em
   runtime, então o token estático termina no separador. O script exige que a
   família tenha ao menos uma variante definida; um status sem regra é um
   compromisso sem tratamento visual.
2. **Apagamento** — classe que `HEAD` definia, que o markup ainda usa, e que hoje
   ninguém define. É design deletado em vez de portado.

Exceções codificadas no script (`ANCHOR_ONLY`), para que um run limpo signifique
algo: `channels-ai-page` é âncora das regras `:global(.channels-ai-*)` do CSS
module, e `conversation-referral` / `conversation-status-picker` são hooks de
teste/e2e cujo estilo vem de tokens no próprio componente.

Ele já encontrou dívida real nesta base: `.metric`, `.accent`, `.warning` e
`.btn.warn` eram **fantasmas** (usadas em 6/15/38/28 arquivos, definidas em
lugar nenhum — nem antes do refactor); `.grid4`, `.grid-main` e `.agent-layout`
existiam só com overrides em media query, sem regra base (no desktop não havia
grid nenhum); e `.pipeline-column--active/--dimmed`, o feedback de drag-and-drop
do board, nunca teve regra. Todas consolidadas.

**Remoção líquida grande de CSS é sinal de alerta, não de progresso.** Quando
`agenda.css` caiu 68%, a verificação foi: das 64 classes removidas, 53 eram uma
feature morta de avaliação de IA e 11 eram primitives que passaram a ser de
`components.css`/`shell.css` — nenhuma perdida. Faça essa conta antes de aceitar
um encolhimento.

### Baseline dos gates (pré-refactor, medido no início da sessão)

`tsc 0 · eslint 0 · vitest 407/407 em 88 arquivos · next build OK`.

O painel estava **totalmente verde** antes do refactor — então qualquer falha ao
final é atribuível a esta mudança, não a dívida pré-existente. (O backend, ao
contrário, tem falhas pré-existentes no HEAD; não confunda os dois.)

### Testes que fazem asserção sobre CSS

`tests/style-sources.ts` deriva a lista de stylesheets de `app/globals.css`.
Antes, seis testes mantinham a lista duplicada à mão; quando um domínio novo
entrava em `globals.css` e não nas cópias, os testes liam uma concatenação
desatualizada e passavam sobre design já apagado.

Quando um desses testes quebra num refactor, decida o que ele é:
- **intenção real, expressão frágil** ("o tooltip não pode ser cortado" pinado
  como `top:-62px`) → preserve a intenção, reescreva como regex/semântica;
- **obsoleto** → substitua por uma asserção sobre a implementação atual e comente
  por quê, para o próximo leitor não restaurar a expectativa antiga.
Um deles será uma regressão genuína. Corrija o código, depois o teste.

Antes de confiar numa auditoria de runtime, **confirme que o CSS carregou** —
um `next start` velho servindo um manifest antigo faz todo hash de CSS dar 404 e
a página renderiza sem estilo, produzindo centenas de falsos "texto invisível":

```bash
CSS=$(curl -s "$BASE/login" | grep -oE '/_next/static/css/[a-f0-9]+\.css' | head -1)
curl -s -o /dev/null -w 'status=%{http_code} type=%{content_type}\n' "$BASE$CSS"
# exija status=200 e type=text/css
```

Métrica limpa não é design bom: **inspecione cada tela** nos dois temas antes de
deployar. A v1 deste refactor passou em todas as métricas e ainda assim destruiu
o login.
