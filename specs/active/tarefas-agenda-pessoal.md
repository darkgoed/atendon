# SPEC: tarefas-agenda-pessoal (L1 do comments.md)

## Objective
/tarefas ganha uma visão de "Agenda pessoal": as tarefas do próprio usuário organizadas
por data de prazo (dia), para ver o dia/semana sem sair da página.

## Source
comments.md L1.

## Current State
- `app/tarefas/page.tsx`: listagem com filtros scope (mine/team), status, prioridade;
  cards `article` com Badge de status/prioridade, prazo formatado, ações.
- `app/tarefas/tarefas.module.css`: estilos da página.
- Backend `/tasks` já devolve `due_at`, `assignee`, `scope=mine` — nada de backend novo.

## Desired Behavior
Toggle de visão "Lista | Agenda" no header de /tarefas (persistido por usuário no
localStorage, chave `atendon-tasks-view`):
- Lista = comportamento atual intacto.
- Agenda = agrupamento por DIA (due_at), seções: "Atrasadas" (due < hoje, não concluídas),
  "Hoje", dias futuros em ordem ("ter, 23 set"), "Sem prazo" ao final. Sem data no formato
  local do usuário (Intl pt-BR). Concluídas aparecem no dia do due_at com visual riscado
  (styles.taskDone já existe) — nenhuma tarefa some da agenda por estar concluída.
- Agenda usa o MESMO escopo/filtros ativos (scope=mine padrão). Cartão = o mesmo markup do
  card de lista (reuso do article), só o agrupamento muda.

## Requirements
### R1 — Toggle Lista/Agenda
Botões segmentados (mesma linguagem do `.pipeline-page__view`), aria-pressed, no header.
Acceptance: mudar de visão não refetch (mesma lista SWR, só re-render).
Verification: vitest render + clique, `queryByRole("listitem"|"article")` etc.

### R2 — Agrupamento por dia
Agrupar client-side por due_at local (usar a timezone da sessão se presente). Tarefas
sem due_at viram grupo "Sem prazo". Sem tarefas na visão agenda → EmptyState existente.
Acceptance: tarefa com prazo ontem aparece em "Atrasadas"; hoje em "Hoje".
Verification: teste de unidade do agrupador (função pura, arquivo próprio se necessário).

### R3 — Sem regressão
Lista atual, TaskDialog, concluir/excluir, load-more e poll continuam idênticos na visão
Lista. Filtros continuam aplicando nas duas visões.

## Invariants
- /agenda (agendamentos) NÃO é tocado.
- Sem nova rota/endpoint; sem mudança de contrato `/tasks`.

## Edge Cases
- due_at inválido (Date NaN) → grupo "Sem prazo" (nunca crash).
- Datas sem hora: agrupar por dia civil do fuso da sessão, não UTC.

## Dependencies
Nenhuma.

## Affected Areas
app/tarefas/page.tsx, app/tarefas/tarefas.module.css, possivelmente app/tarefas/tasks-agenda.tsx
(componente de extração), tests/tasks-agenda.test.tsx (novo).

## Non-goals
- Sem drag para reagendar (backend não tem PATCH de due_at por drag nesta rodada).
- Sem integração com appointments.

## Constraints
- Ponytail: função pura `groupTasksByDay(tasks, today)`; sem lib de datas.

## Required Tests
- tests/tasks-agenda.test.tsx: toggle persistido; agrupamento (atrasada/hoje/futuro/sem prazo);
  visão lista intacta (render igual).

## Definition of Done
- [ ] R1-R3 verificados; vitest+tsc verdes; build verde.
