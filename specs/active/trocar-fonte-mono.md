# SPEC: Substituir a fonte IBM Plex Mono

## Objective

Remover a IBM Plex Mono do painel, substituindo-a por uma família monoespaçada
diferente, sem alterar layout, tamanhos ou pesos.

## Source

comments.md L96: "Troque a fonte: IBM Plex Mono por outra, não gosto dela"

## Current State

- `apps/panel/app/globals.css:1` — carga via Google Fonts:
  ```css
  @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=Manrope:wght@400;500;600;700&display=swap');
  ```
- Não há uso de `next/font` no painel; `apps/panel/app/layout.tsx:1-11` só
  importa o CSS global.
- Fonte do corpo (não-mono): `Manrope` — `globals.css:104`.
- A família mono é referenciada em dezenas de seletores de `globals.css`
  (entre eles :148, :160, :162, :185-190, :222, :235-236, :336, :341, :363,
  :404-417, :1121, :1185, :1193, :1335, :1348, :1358, :1363, :1375, :1392,
  :1497, :1563) e no utilitário `[class~="font-mono"]` em `globals.css:1121`.
- Consumidores por className `mono` / `font-mono` espalhados pelo painel
  (ex.: `app/workspace/audit/page.tsx:62`, `components/version-banner.tsx:49,81,95`,
  `components/ui/voice-input.tsx:112,289`, `components/web-push-settings.tsx:164`,
  `components/tripz-ai/*`).
- Uso inline em SVG: `components/commercial-dashboard-charts.tsx:39` e outros
  pontos com `fontFamily="'IBM Plex Mono',monospace"`.

## Desired Behavior

Nenhuma referência a "IBM Plex Mono" permanece no painel. Todo texto que hoje é
monoespaçado continua monoespaçado, com outra família, e sem qualquer mudança de
tamanho, peso, espaçamento ou quebra de layout.

## Requirements

### R1 — Token único de fonte monoespaçada

Description: introduzir uma variável CSS (ex.: `--font-mono`) definida uma única
vez, e fazer TODOS os seletores mono consumirem essa variável, em vez de repetir
o nome da família dezenas de vezes.

Acceptance Criteria:
- Existe uma única declaração da pilha monoespaçada em `globals.css`.
- Todos os seletores que antes declaravam `'IBM Plex Mono',monospace` passam a
  usar `var(--font-mono)`.
- `grep -rn "IBM Plex Mono" apps/panel` → 0 resultados (CSS, TSX, TS, JS).

Verification: grep + teste de regressão que afirma ausência da string.

### R2 — Família substituta sem requisição de rede adicional

Description: usar uma pilha monoespaçada de sistema, eliminando o download da
IBM Plex Mono do Google Fonts.

Acceptance Criteria:
- A pilha é:
  `ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace`
- O `@import` do Google Fonts em `globals.css:1` continua carregando Manrope,
  mas NÃO carrega mais `IBM+Plex+Mono`.
- Nenhuma nova dependência npm e nenhum novo arquivo de fonte é adicionado.

Verification: inspeção da linha 1 do globals.css; grep por `IBM+Plex+Mono`.

### R3 — Uso inline em SVG também migrado

Description: os `fontFamily` inline nos gráficos passam a usar a mesma pilha.

Acceptance Criteria:
- `components/commercial-dashboard-charts.tsx` (e qualquer outro `fontFamily`
  inline encontrado) não menciona IBM Plex Mono.
- Os rótulos dos gráficos continuam legíveis e alinhados (sem sobreposição de
  números nos eixos).

Verification: grep + conferência visual do componente.

### R4 — Zero mudança de layout

Description: a troca é puramente de família tipográfica.

Acceptance Criteria:
- Nenhum `font-size`, `font-weight`, `line-height`, `letter-spacing`, largura,
  padding ou margem é alterado nesta SPEC.
- O diff do globals.css contém exclusivamente substituições de `font-family` /
  do shorthand `font:` e a definição da variável nova.

Verification: revisão do diff (`git diff apps/panel/app/globals.css`).

## Invariants

- A fonte do corpo (Manrope) permanece intocada.
- Todo elemento hoje monoespaçado continua monoespaçado — nenhum vira
  proporcional.
- Chaves do CSS permanecem balanceadas (o arquivo é editado em paralelo por
  outras SPECs).

## Edge Cases

- Shorthand `font: <weight> <size>/<lh> 'IBM Plex Mono',monospace` — a
  substituição precisa preservar os demais componentes do shorthand.
- Tabelas e colunas numéricas que dependem de largura de caractere fixa
  (ex.: `.leads-table th`, `.agenda-time`) — a substituta continua sendo
  monoespaçada, então o alinhamento se mantém.
- Ambiente sem nenhuma das fontes listadas → cai em `monospace` genérica.

## Dependencies

Nenhuma.

## Affected Areas

- apps/panel/app/globals.css (arquivo inteiro — esta SPEC é a única autorizada a
  fazer varredura global nele nesta onda)
- apps/panel/components/commercial-dashboard-charts.tsx
- qualquer outro arquivo com `fontFamily` inline citando a fonte

## Non-goals

- Trocar a fonte do corpo (Manrope).
- Redesenhar tipografia, escalas ou hierarquia.
- Adicionar `next/font`.

## Constraints

- `globals.css` é compartilhado nesta rodada: esta SPEC roda em onda exclusiva
  sobre esse arquivo, ou por último, para não conflitar com edições de blocos
  `.agenda-*` / `.pipeline-*`.

## Required Tests

- `apps/panel/tests/font-mono-token.test.ts`: lê `globals.css` e afirma
  (a) ausência de "IBM Plex Mono"; (b) presença de `--font-mono`; (c) que o
  `@import` do Google Fonts não contém `IBM+Plex+Mono`.
  (Aqui a asserção sobre o arquivo é legítima: o artefato verificado É o CSS.)

## Definition of Done

- [ ] R1..R4 atendidos
- [ ] `grep -rn "IBM Plex Mono" apps/panel` → 0
- [ ] `npx tsc --noEmit` (painel) 0 erros
- [ ] `npx vitest run` (painel) exit 0
- [ ] Chaves do globals.css balanceadas
- [ ] Diff contém apenas trocas de família tipográfica
