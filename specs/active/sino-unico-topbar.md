# SPEC: sino-unico-topbar (L3 do comments.md)

## Objective
Um único sino de notificações internas na topbar à direita. Zero sinos flutuantes (FAB)
no canto inferior direito: o NotificationCenter (contatos) é apagado e o sino interno
para de ser FAB (vira item inline da topbar).

## Source
comments.md L3.

## Current State
- `components/shell.tsx:486` `<InternalNotifications />` na topbar, mas o CSS module
  `.trigger` o fixa em right:24px/bottom:24px (FAB visual).
- `components/shell.tsx:515-518` `<NotificationCenter />` FAB BellRinging (contatos não lidos),
  oculto em /conversas.
- CSS: `.notification-center*` em styles/domains/feedback.css (196-260, 575-595).

## Desired Behavior
- Nenhuma bolha/sino flutuante no canto inferior direito em NENHUMA página (desktop+mobile).
- Exatamente UM sino: o interno, inline na topbar direita (onde já está no DOM), com badge.
- NotificationCenter e seus testes/CSS removidos por completo (arquivo, imports, CSS).

## Requirements
### R1 — Sino interno inline na topbar
`components/internal-notifications.module.css`: `.trigger` deixa de ser `position: fixed`
e passa a ser gatilho inline (alt ~32px, pill, tokens AtendON, mantém badge + ícone Bell
fill/regular por unread). Sem mudaça no DOM do shell.
Acceptance:
- `grep position: fixed` não encontra `.trigger` no module.css.
- `/conversas` e `/` mostram o sino na topbar (probe visual).
Verification: vitest tests/internal-notifications.test.tsx (deve passar sem mudança de
comportamento — API PopoverMenu preservada).

### R2 — NotificationCenter apagado
Deletar `components/notification-center.tsx`; remover import/render de `shell.tsx`;
remover blocos `.notification-center*` de `feedback.css` (incl. media query 575-595);
remover `/conversations/unread` SWR órfão (só existia para o sino).
Acceptance: `grep -ri "NotificationCenter\|notification-center" apps/panel/{app,components,lib,styles,tests}` → só histórico/git.
Não deixar CSS órfão (build limpa, mas o arquivo não pode conter classes mortas).

### R3 — Sem regressão de toasts
`MessageNotifications` (toasts) permanece. Nada de tocar som/realtime.

## Invariants
- PopoverMenu do sino: aria-label "Sino de notificações", mark-all/read all, otimismo — intactos.
- Nada de novo fetch: `/me/internal-notifications` continua a única fonte do sino.

## Edge Cases
- Mobile ≤700px: topbar direita não pode virar overflow (topbar__meta compacta; sino ≤ 40px).
- Sem notificações: sino vazio, badge ausente (já existe).

## Dependencies
Nenhuma (só painel).

## Affected Areas
shell.tsx, notification-center.tsx (DEL), internal-notifications.module.css, feedback.css,
tests (novo teste de regressão: shell.tsx não contém "NotificationCenter"; module.css sem
position:fixed no .trigger).

## Non-goals
- Não portar conteúdo de conversas não lidas para o sino interno (D2 do progress.md).
- Não mexer em /alertas (central ROOT) nem em MessageNotifications.

## Constraints
- Ponytail FULL: menor diff; sem abstrações novas; reusar PopoverMenu e styles module.

## Required Tests
- tests/internal-notifications.test.tsx segue passando.
- Novo teste de fonte (node env): shell.tsx não importa NotificationCenter; module.css não
  fixa .trigger.

## Definition of Done
- [ ] R1, R2, R3 verificados (vitest + tsc + grep).
- [ ] `npm run build` (eslint --max-warnings=0) verde.
