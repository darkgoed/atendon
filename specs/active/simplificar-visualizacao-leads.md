# SPEC: Simplificação da visualização de leads

## Objective
Exibir a qualificação do lead de forma compacta e útil, sem respostas estruturadas, justificativa interna ou Timeline.

## Source
comments.md

## Current State
O detalhe mostra resumo, justificativa, grade de respostas e Timeline completa. A lista já exibe o resumo truncado.

## Desired Behavior
O detalhe mantém os sinais essenciais da qualificação e apresenta apenas seu resumo narrativo; eventos continuam disponíveis no backend, mas não aparecem nessa tela.

## Requirements
### R1 — Qualificação resumida
Remover da interface do detalhe as respostas estruturadas e a justificativa interna.

Acceptance Criteria:
- O card de qualificação mostra estrelas, situação, metadados existentes e resumo.
- Os textos “Respostas estruturadas”, “Nenhuma resposta estruturada foi registrada” e “Justificativa interna” não existem no componente.
- Dados persistidos e contrato backend não são alterados.

Verification:
- Teste Vitest de regressão por fonte.
- Typecheck e build do painel.

### R2 — Sem Timeline no detalhe
Remover a seção Timeline de `/leads/[id]`.

Acceptance Criteria:
- O componente não importa/renderiza `ReadableDetails` ou `leadEventLabel`.
- A seção visual “Timeline” e o loop de `data.eventos` não existem.
- Nenhuma rota ou persistência de eventos é removida.

Verification:
- Teste Vitest de regressão por fonte.
- Typecheck e build do painel.

### R3 — Layout mais simples
Reduzir a densidade do card de qualificação sem remover controles operacionais.

Acceptance Criteria:
- O resumo ocupa um único bloco legível.
- Notas, acompanhamento, dados, status, transferência e agendamentos permanecem funcionais e condicionados às permissões existentes.

Verification:
- Inspeção do diff e testes do painel.

## Invariants
- Sem alteração de autorização, API ou banco.
- Sem remover funcionalidades operacionais.

## Edge Cases
- Resumo nulo continua exibindo fallback.
- Lead sem qualificação mantém estado vazio e ação de qualificar quando permitida.

## Dependencies
Nenhuma nova dependência.

## Affected Areas
- `apps/panel/app/leads/[id]/page.tsx`
- `apps/panel/tests/comments-ui-regression.test.ts`

## Non-goals
- Excluir respostas estruturadas do banco/API.
- Excluir eventos ou auditoria do backend.
- Redesenhar pipeline ou filtros.

## Constraints
Preservar mudanças preexistentes e estilo atual do painel.

## Required Tests
- Regressão da tela simplificada de leads.
- Suite do painel, lint, typecheck e build.

## Definition of Done
- [x] R1–R3 atendidos.
- [x] Testes e validações passam.
- [x] Revisão independente aprova.
