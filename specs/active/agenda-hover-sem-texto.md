# SPEC: Agenda — hover das células/leads sem texto algum

## Objective

Remover completamente o texto que aparece ao passar o mouse sobre as células e
os leads da /agenda ("Compartilhado", "N livre(s)", "Conflito") e os tooltips
nativos (`title`) associados, sem perder acessibilidade.

## Source

comments.md L105: "O hover dos leads da agenda, não deve aparecer 'Compartilhado
ou Livre' não deve ter texto nenhum no hover"

## Current State

- `apps/panel/app/agenda/agenda-calendar.tsx:111` — calcula `availabilityLabel`
  com os valores `"{n} livre(s)"`, `"Compartilhado"`, `"Conflito"`.
- `apps/panel/app/agenda/agenda-calendar.tsx:128` — renderiza esse rótulo em
  `<span className="mono agenda-cell__vagas" title={...}>`.
- `apps/panel/app/globals.css:1373-1375` — `.agenda-cell__vagas` fica invisível
  quando existe agendamento e reaparece em `.agenda-cell:hover` /
  `:focus-within`. É exatamente o texto que o usuário vê no hover.
- `agenda-calendar.tsx:128, :142, :145` — três atributos `title` nativos, que
  produzem tooltip do navegador.
- `apps/panel/tests/agenda-assignees-ui.test.ts` — asserta literalmente a string
  "Compartilhado" e o texto explicativo do `title`.

## Desired Behavior

Passar o mouse (ou focar via teclado) sobre uma célula/lead da agenda não exibe
nenhum texto novo — nem texto renderizado que só aparece no hover, nem tooltip
nativo do navegador. As informações de disponibilidade continuam disponíveis
para leitores de tela.

## Requirements

### R1 — Nenhum texto revelado por hover/focus na agenda

Description: `.agenda-cell__vagas` deixa de ser um elemento revelado no hover.
O rótulo de disponibilidade não é mais renderizado como texto visível.

Acceptance Criteria:
- `apps/panel/app/globals.css` não contém nenhuma regra que torne
  `.agenda-cell__vagas` (ou equivalente) visível em `:hover` ou `:focus-within`.
- Nenhuma célula da agenda renderiza texto visível cujo único gatilho de
  exibição seja hover/focus.
- As strings "Compartilhado", "livre(s)" e "Conflito" não aparecem como texto
  visível na célula.

Verification:
- `npx vitest run` em apps/panel com o teste atualizado de R3.
- Inspeção do CSS: busca por `agenda-cell:hover` não retorna regra que exiba
  `.agenda-cell__vagas`.

### R2 — Nenhum tooltip nativo nas células da agenda

Description: remover os atributos `title` de agenda-calendar.tsx:128, :142, :145.

Acceptance Criteria:
- `agenda-calendar.tsx` não contém nenhum atributo `title=` .
- Nenhum outro arquivo em `apps/panel/app/agenda/**` ganha `title=` como
  substituto.

Verification:
- `grep -n "title=" apps/panel/app/agenda/*.tsx` → vazio.

### R3 — Acessibilidade preservada e testes ajustados

Description: a informação de disponibilidade permanece acessível a leitores de
tela via `aria-label` e/ou `sr-only`, que NÃO são exibidos visualmente. Os
testes que dependiam do texto visível passam a exigir o novo comportamento.

Acceptance Criteria:
- A célula continua expondo a disponibilidade por `aria-label` ou conteúdo
  `sr-only` (classe já existente no projeto).
- `apps/panel/tests/agenda-assignees-ui.test.ts` é atualizado para exigir a
  AUSÊNCIA do texto visível e a PRESENÇA do rótulo acessível — nunca para
  simplesmente remover a asserção.
- Nenhum teste é deletado ou marcado como skip para fazer a suíte passar.

Verification:
- `npx vitest run` em apps/panel → exit 0.
- `npx tsc --noEmit -p tsconfig.json` em apps/panel → 0 erros.

## Invariants

- O layout, as cores, as fontes e o espaçamento da agenda permanecem
  inalterados. Isto é remoção de texto de hover, não redesign.
- A funcionalidade de clique no slot (criar/abrir agendamento) continua igual.
- Nenhuma lógica de disponibilidade (cálculo de vagas/conflito) é removida — só
  a sua apresentação visual no hover.

## Edge Cases

- Célula sem agendamento: hoje o rótulo pode estar visível permanentemente (não
  só no hover). O requisito do usuário é sobre o hover; manter visível o que já
  era permanentemente visível é aceitável, MAS o texto não pode surgir/mudar por
  causa do hover.
- Navegação por teclado (`:focus-within`) deve seguir a mesma regra do hover.
- Modo mês (`agenda-month.tsx`) — verificar se replica o mesmo padrão.

## Dependencies

Nenhuma.

## Affected Areas

- apps/panel/app/agenda/agenda-calendar.tsx
- apps/panel/app/agenda/agenda-month.tsx (verificar)
- apps/panel/app/globals.css (bloco `.agenda-*`, ~linhas 1373-1375)
- apps/panel/tests/agenda-assignees-ui.test.ts

## Non-goals

- Redesenhar a agenda.
- Alterar a lógica de capacidade/vagas/conflito.
- Mexer em tooltips de outras rotas (/uso, /leads etc.).

## Constraints

- Não introduzir biblioteca de tooltip.
- globals.css é compartilhado com outras SPECs desta rodada: editar SOMENTE o
  bloco `.agenda-*`.

## Required Tests

- `apps/panel/tests/agenda-assignees-ui.test.ts` atualizado: asserta que
  agenda-calendar.tsx não contém `title=` e que o CSS não revela
  `.agenda-cell__vagas` no hover.

## Definition of Done

- [ ] R1 atendido e verificado
- [ ] R2 atendido e verificado (`grep title=` vazio)
- [ ] R3 atendido: aria-label/sr-only presente, teste atualizado exigindo o
      comportamento novo
- [ ] `npx vitest run` (painel) exit 0
- [ ] `npx tsc --noEmit` (painel) 0 erros
- [ ] Nenhuma alteração de layout/cor/fonte na agenda
