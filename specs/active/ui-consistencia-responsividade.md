# SPEC: Consistência e responsividade da UI (agenda e demais módulos)

## Objective

Eliminar defeitos concretos e verificáveis de consistência/responsividade em
todo o painel — botões com texto quebrado/estourado, textos sobrepostos, ícones
colados/sobrepostos ao texto, grids que não colapsam, overflow horizontal —
começando por /agenda, PRESERVANDO integralmente o design atual.

## Source

comments.md L94: "Em /agenda, precisa ser corrigido problema de consistencia e
responsividade, creio que deve ser resolvido em todos os modulos/telas, tem
botões com textos bugados, tem texto sobrepostos, icones sobrepostos a textos,
faça uma analise PROFUNDA sobre isso"

## Current State

Investigação cobriu as 32 rotas `app/**/page.tsx`, `components/**`, os arquivos
de `/agenda` e `app/globals.css` (1.579 linhas). A maior parte do painel já tem
contenções corretas (`min-w-0`, `truncate`, `overflow-x-auto`, tabelas
responsivas, breakpoints). Defeitos concretos localizados:

| Prioridade | Local | Defeito |
|---|---|---|
| Alta | `app/agenda/agenda-detail-dialog.tsx:46` | Select de responsável força overflow horizontal em diálogo estreito |
| Alta | agenda — grade de ações | Vários botões empilhados sem hierarquia nem largura mínima, texto quebrando |
| Média | `app/pos-venda/cobranca/page.tsx:63-71` | `grid md:grid-cols-4` e `md:grid-cols-3` sem passo `sm:` → apertado entre 560-767px |
| Média | `globals.css:1124-1128, 1273-1275` | `.post-sales-summary` com 5 colunas `minmax(100px,1fr)` e `overflow-x` aplicado ao próprio grid |
| Média | `globals.css:1192-1205, 1299-1300` | Linha de checklist de pós-venda só reorganiza abaixo de 560px |

Padrões já existentes no projeto, a REUTILIZAR em vez de inventar:
- tabela responsiva: `admin-table-wrap responsive-table-wrap` +
  `admin-table responsive-table` com `data-label` por `<td>`
  (ex.: `app/workspace/members/page.tsx:224-226`)
- utilitários de contenção: `min-w-0`, `truncate`
- blocos CSS nomeados: `.agenda-*`, `.leads-*`, `.pipeline-*`, `.post-sales-*`

## Desired Behavior

Em qualquer largura de viewport entre 360px e 1920px, em todas as rotas do
painel: nenhum scroll horizontal da página, nenhum texto sobreposto a outro,
nenhum ícone colado ou sobreposto ao rótulo do botão, nenhum rótulo de botão
cortado, e todo container com conteúdo largo tem sua própria área de rolagem.

## Requirements

### R1 — Auditoria automatizada e reprodutível (a "análise profunda")

Description: criar um harness que meça os defeitos objetivamente, em vez de
depender de inspeção subjetiva. O projeto já tem Playwright vendorizado
(`node_modules/playwright`, browsers em `~/.cache/ms-playwright`).

O harness precisa do painel servido. Ordem de tentativa:
1. `npm run build` + `npm start` no painel (ou `npm run dev`), apontando a API
   para um mock/stub, e auditar as rotas autenticáveis;
2. se o painel não subir neste ambiente (falta de backend/DB), NÃO fabricar
   resultado: registrar `BLOCKED` com a saída real do erro e cair para o modo
   estático descrito abaixo.

Modo estático (fallback obrigatório se o modo 1 falhar): varredura de
`app/**/*.tsx`, `components/**/*.tsx` e `globals.css` detectando por AST/regex
os padrões de risco enumerados, produzindo o mesmo formato de relatório.

Acceptance Criteria:
- Existe um script de auditoria versionado (ex.:
  `apps/panel/scripts/ui-responsive-audit.mjs`) que, para cada rota do painel e
  para os viewports 360, 414, 768, 1024, 1280 e 1920px, detecta e reporta:
  1. `document.documentElement.scrollWidth > clientWidth` (overflow horizontal
     da página);
  2. elementos cujo `scrollWidth > clientWidth` sem `overflow` rolável no
     ancestral (texto cortado);
  3. pares de elementos de texto com retângulos sobrepostos;
  4. botões cujo conteúdo textual excede a caixa (rótulo quebrado/cortado);
  5. botões com ícone cuja distância entre ícone e texto é 0 (ícone colado).
- A saída é um relatório JSON versionável, com rota, viewport, seletor e tipo de
  defeito.
- O script é executável por um comando único documentado no `package.json`.
- O modo efetivamente usado (dinâmico ou estático) é declarado no relatório.
  Relatório vazio SÓ é aceito com evidência de que a auditoria realmente rodou.

Verification: rodar o script e anexar o relatório; a lista de defeitos é a base
factual dos demais requisitos.

### R2 — Zero overflow horizontal de página

Description: nenhuma rota gera barra de rolagem horizontal no documento.

Acceptance Criteria:
- Para toda rota auditada, em todos os viewports do R1, o overflow horizontal do
  documento é 0.
- Conteúdo largo (tabelas, grids de muitas colunas) rola dentro do PRÓPRIO
  container, não na página.
- Especificamente: `.post-sales-summary` (globals.css:1124-1128, 1273-1275)
  passa a rolar num wrapper dedicado, não no grid.

Verification: relatório do R1 com zero ocorrências do tipo 1.

### R3 — Botões legíveis e com ícone espaçado

Description: nenhum rótulo de botão é cortado, quebrado de forma ilegível, nem
colado ao ícone.

Acceptance Criteria:
- Todo botão com ícone + texto tem espaçamento explícito entre eles (`gap`), sem
  depender de margem acidental.
- Nenhum botão apresenta texto cortado nos viewports do R1.
- Onde o rótulo é longo demais para a caixa, aplica-se contenção explícita
  (`min-w-0` + `truncate` com `title` acessível OU quebra controlada), nunca
  redução de fonte ad-hoc.
- A grade de ações do diálogo da agenda define uma ação primária em largura
  total e agrupa as secundárias, evitando a pilha de botões sem hierarquia.

Verification: relatório do R1 com zero ocorrências dos tipos 4 e 5.

### R4 — Nenhum texto sobreposto

Description: nenhum par de elementos de texto se sobrepõe visualmente.

Acceptance Criteria:
- Relatório do R1 com zero ocorrências do tipo 3.
- Correções feitas por layout (grid/flex/espaçamento), não por `z-index` para
  esconder um elemento sob o outro.

Verification: relatório do R1.

### R5 — Grids colapsam progressivamente

Description: grids de múltiplas colunas ganham passo intermediário.

Acceptance Criteria:
- `app/pos-venda/cobranca/page.tsx:63-71`: `md:grid-cols-4` →
  `sm:grid-cols-2 md:grid-cols-4`; `md:grid-cols-3` →
  `sm:grid-cols-2 md:grid-cols-3`.
- A linha de checklist de pós-venda (globals.css:1192-1205, 1299-1300) ganha
  reorganização também na faixa intermediária, não só abaixo de 560px.
- Nenhum grid do painel salta de 4+ colunas direto para 1 sem passo
  intermediário.

Verification: relatório do R1 nos viewports 414 e 768.

### R6 — Diálogo da agenda contido

Description: `app/agenda/agenda-detail-dialog.tsx:46` não força overflow.

Acceptance Criteria:
- O select de responsável tem `min-w-0` (ou `width:100%` com `max-width`) e não
  expande o diálogo além do viewport.
- O diálogo respeita `max-width` e `max-height` do viewport, com rolagem interna
  quando o conteúdo excede.

Verification: relatório do R1 na rota /agenda em 360px.

## Invariants

- DESIGN PRESERVADO: fontes, famílias, cores, tokens, raios, sombras, hierarquia
  visual e componentes permanecem os mesmos. Este é um trabalho de
  preserve-and-repair, NÃO um redesign.
- Nenhum componente é substituído por outro; nenhuma biblioteca de UI é
  adicionada.
- Nenhuma funcionalidade é removida para "simplificar" o layout.
- Chaves do `globals.css` permanecem balanceadas.
- Acessibilidade não regride: contraste, `aria-label`, foco visível e ordem de
  tabulação preservados.

## Edge Cases

- Textos longos em português (rótulos maiores que em inglês) — testar com o
  conteúdo real, não com placeholder curto.
- Nomes de contato/lead muito longos e e-mails sem espaço.
- Tabelas com muitas colunas em 360px.
- Modais dentro de modais / dropdown dentro de modal (empilhamento).
- Estados de carregamento (skeleton) também precisam respeitar o layout.
- Zoom do navegador em 150% (equivale a viewport menor).

## Dependencies

Toca `globals.css`, disputado com `trocar-fonte-mono` e
`agenda-hover-sem-texto`; e arquivos de `/agenda`, disputados com
`agenda-hover-sem-texto` e `lead-reagendar-e-trava-responsavel`. Deve rodar
DEPOIS dessas, para auditar o layout final.

## Affected Areas

- apps/panel/app/agenda/agenda-detail-dialog.tsx
- apps/panel/app/pos-venda/cobranca/page.tsx
- apps/panel/app/globals.css (blocos `.post-sales-*` e os que a auditoria apontar)
- demais arquivos apontados pelo relatório do R1
- novo: apps/panel/scripts/ui-responsive-audit.mjs

## Non-goals

- Redesenhar qualquer tela.
- Trocar fonte (é a SPEC `trocar-fonte-mono`).
- Alterar comportamento de negócio.
- Migrar para outro sistema de grid/CSS.

## Constraints

- `globals.css` é compartilhado: coordenar por bloco nomeado.
- Build do painel roda `eslint --max-warnings=0`.
- Sem Chrome/Chromium no PATH: usar o Playwright vendorizado do repo em modo
  headless.

## Required Tests

- O relatório do R1 antes e depois, versionado, mostrando a redução a zero das
  categorias 1, 3, 4 e 5.
- `apps/panel/tests/responsive-regression.test.ts`: para os defeitos corrigidos,
  testes que falhariam se a regressão voltasse (ex.: classes de breakpoint
  presentes, wrapper de rolagem presente).
- Testes importam código de produção / verificam o CSS real; proibido inventar
  número de defeitos sem rodar a auditoria.

## Definition of Done

- [ ] R1 entregue: script de auditoria roda e produz relatório real (colar saída)
- [ ] R2..R6 atendidos, comprovados pelo relatório pós-correção
- [ ] `npx tsc --noEmit` (painel) 0 erros
- [ ] `npx vitest run` (painel) exit 0
- [ ] `npx eslint . --max-warnings=0` no painel → 0
- [ ] Diff revisado: nenhuma mudança de cor, fonte, token ou componente
- [ ] Chaves do globals.css balanceadas
