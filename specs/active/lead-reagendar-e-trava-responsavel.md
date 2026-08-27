# SPEC: Reagendar após comparecimento e travar troca automática de responsável

## Objective

(A) Permitir reagendar um lead cujo agendamento já foi marcado como
`concluido` (compareceu) ou `no_show` (não compareceu), voltando automaticamente
para `confirmado`.
(B) Impedir que, depois de registrado o comparecimento/não-comparecimento,
qualquer rotina automática troque o responsável do lead — só transferência
manual pelo próprio closer dono ou por cargo superior.

## Source

- comments.md L102: "Lead que compareceu ou não compareceu, deve ter botão para
  reagendar o lead, após lead reagendado automaticamente o status vai para
  confirmado normalmente"
- comments.md L103: "Após o comparecimento ou não comparecimento, o lead não pode
  MUDAR de responsavel, somente se transferido pelo proprio closer ou cargo
  maior, mas não pode ser alterador para outro closer de forma automatica"

## Current State

### Enums reais

- Status do agendamento — `apps/backend/src/modules/scheduling/service.ts:42`:
  ```ts
  appointmentStatus = z.enum(["confirmado","reagendado","cancelado","concluido","no_show"])
  ```
  - `FinalAppointmentStatus` (:45) = `"cancelado" | "concluido" | "no_show"`
  - eventos (:66-67): `concluido → "agendamento_concluido"`,
    `no_show → "agendamento_no_show"`
- Status técnico do lead — `apps/backend/src/modules/organization/domain.ts:1-14`:
  `novo, em_atendimento, aguardando_resposta, qualificado, agendado,
  em_negociacao, proposta_enviada, follow_up, fechado, perdido`
  (schema Zod derivado em `scheduling/service.ts:41`).
- Motivos de atribuição — `apps/backend/src/modules/assignments/*`:
  `novo_contato`, `lead_criado`, `retorno_conversa_encerrada`,
  `reuniao_sem_responsavel`, `pool_expandido`, `transferencia_manual`,
  `removido_do_pool`. Só `transferencia_manual` é ação humana.

### Bloqueios que impedem (A) hoje

- `scheduling/service.ts:71` — transições permitidas:
  ```ts
  return status === "confirmado" || status === "reagendado"
    ? ["cancelado","concluido","no_show"] : [];
  ```
  Ou seja, de `concluido`/`no_show` não sai nada.
- `scheduling/service.ts:2200` — o handler de reagendamento rejeita:
  ```ts
  if (["cancelado","concluido","no_show"].includes(current.rows[0].status))
    throw httpError(409, "Agendamento não pode ser reagendado neste status");
  ```
- Painel: a ação de reagendar existe em
  `apps/panel/app/agenda/use-agenda-actions.ts:90-107` e `:115-128`, chamando
  `POST /scheduling/appointments/:id/reagendar`.
- `apps/panel/app/agenda/agenda-detail-dialog.tsx:129-131` só exibe ações finais
  para agendamentos ativos. Para `concluido` mostra "Corrigir para não
  compareceu"; para `no_show`, "Corrigir para compareceu". Não há botão
  "Reagendar" nesses estados.

### Pontos que trocam responsável automaticamente (risco de (B))

Em `apps/backend/src/modules/assignments/service.ts`:
- `lockAttendantRotation` (:35)
- `assignConversationTo...` (:106)
- `ensureCaseAssignment` — chamado por `modules/qualification/service.ts:411`
  entre outros; se não houver responsável atual/preferido, dispara
  `selectNextAttendant` (round-robin)
- `rebalanceUnscheduledAssignments` (:669-722) — redistribui via
  `selectNextAttendant`
- `transferCaseAssignment` (:724-793) — caminho MANUAL legítimo; atualiza lead,
  conversa e agendamentos
- `redistributeRemovedAssignments` — redistribui após remoção do pool

Migrations de round-robin que filtram apenas o status do LEAD, ignorando o
status do AGENDAMENTO —
`apps/backend/src/db/migrations/0088_attendant_case_round_robin.sql:38-46`,
`:103-112`, `:165-174`, `:176-234`, `:236-253`:
```sql
lead.status NOT IN ('recusado','cancelado')
```
Não há nenhuma proteção para leads cujo agendamento esteja em `concluido` ou
`no_show`.

RBAC: `apps/backend/src/auth/rbac.ts` (nota: NÃO existe
`src/modules/auth/rbac.ts`). Papéis com `is_owner_role`; a rota de papéis
em `modules/.../routes.ts:126` já usa a noção de hierarquia
("OWNER exige transferência explícita de propriedade").

## Desired Behavior

- No detalhe de um agendamento `concluido` ou `no_show`, existe o botão
  "Reagendar". Ao reagendar, o agendamento volta para `confirmado` e o histórico
  registra a transição.
- Nenhuma rotina automática reatribui o responsável de um lead cujo agendamento
  já atingiu `concluido` ou `no_show`. Só `transferencia_manual` feita pelo
  closer dono ou por cargo superior consegue mudar.

## Requirements

### R1 — Transição de reagendamento a partir de concluido/no_show

Description: permitir a saída de `concluido` e `no_show` para reagendamento.

Acceptance Criteria:
- `scheduling/service.ts:71` (ou equivalente) passa a permitir a transição de
  `concluido` e `no_show` para `confirmado` via reagendamento.
- `cancelado` continua NÃO reagendável (o usuário não pediu isso).
- O guard de `:2200` deixa de rejeitar `concluido`/`no_show`, mas continua
  rejeitando `cancelado` com 409 e mensagem clara.
- Toda outra transição inválida continua rejeitada.

Verification: teste unitário da matriz de transições, cobrindo cada par
origem→destino.

### R2 — Status volta automaticamente para confirmado

Description: após o reagendamento bem-sucedido, o status final é `confirmado`.

Acceptance Criteria:
- Reagendar um agendamento `concluido` resulta em status `confirmado`.
- Reagendar um `no_show` resulta em status `confirmado`.
- A nova data/hora é a informada na requisição; a antiga fica no histórico.
- Um evento de auditoria é registrado com o status anterior, o novo, o autor e o
  horário — nada é sobrescrito silenciosamente.

Verification: teste de integração do endpoint `POST
/scheduling/appointments/:id/reagendar`.

### R3 — Botão Reagendar visível nos estados finais de comparecimento

Description: o painel exibe a ação nos estados `concluido` e `no_show`.

Acceptance Criteria:
- `agenda-detail-dialog.tsx` exibe "Reagendar" quando o status é `concluido` ou
  `no_show`, além dos estados já suportados.
- O botão respeita a permissão já usada hoje pela ação de reagendar — nenhuma
  permissão nova, nenhuma afrouxada.
- O botão reutiliza `use-agenda-actions.ts:90-107/115-128` — a chamada HTTP não
  é reimplementada.
- Após sucesso, a UI reflete `confirmado` sem exigir reload manual.
- Para `cancelado`, o botão NÃO aparece.

Verification: teste de UI para cada status.

### R4 — Trava de reatribuição automática após comparecimento

Description: introduzir uma verificação central que impeça qualquer motivo
automático de trocar o responsável de um lead com agendamento em `concluido` ou
`no_show`.

Acceptance Criteria:
- Existe uma função única (ex.: `assignmentIsLockedByAttendance(client, leadId)`)
  usada por TODOS os caminhos automáticos: `ensureCaseAssignment`,
  `rebalanceUnscheduledAssignments`, `redistributeRemovedAssignments`,
  `selectNextAttendant` e qualquer outro ponto que grave responsável com motivo
  diferente de `transferencia_manual`.
- Motivos bloqueados: `novo_contato`, `lead_criado`,
  `retorno_conversa_encerrada`, `reuniao_sem_responsavel`, `pool_expandido`,
  `removido_do_pool` e qualquer motivo automático futuro.
- Único motivo permitido: `transferencia_manual`.
- Quando bloqueado, a rotina automática NÃO falha ruidosamente: ela pula o lead
  e registra log/telemetria — não deve derrubar o rebalanceamento inteiro.
- A trava é aplicada dentro da mesma transação/lock da atribuição, para não ter
  corrida entre a checagem e a escrita.

Verification: teste que executa cada rotina automática sobre um lead com
agendamento `concluido` e afirma que o responsável não mudou.

### R5 — Transferência manual autorizada por dono ou cargo superior

Description: `transferCaseAssignment` continua funcionando, mas com autorização
explícita.

Acceptance Criteria:
- A transferência é permitida se o ator for o closer/responsável atual do lead,
  OU tiver cargo hierarquicamente superior segundo o RBAC existente
  (`apps/backend/src/auth/rbac.ts`) — sem inventar permissão nova.
- Um closer que NÃO é o dono e não tem cargo superior recebe 403.
- A transferência registra motivo `transferencia_manual` e o ator.
- A trava do R4 não bloqueia esse caminho.

Verification: testes de autorização para dono, cargo superior e terceiro sem
poder.

### R6 — Rotinas SQL de round-robin respeitam a trava

Description: as consultas de round-robin deixam de considerar elegíveis os leads
com agendamento em `concluido`/`no_show`.

Acceptance Criteria:
- Os pontos equivalentes a
  `0088_attendant_case_round_robin.sql:38-46, :103-112, :165-174, :176-234,
  :236-253` passam a excluir leads cujo agendamento esteja em `concluido` ou
  `no_show`, além do filtro atual de status do lead.
- Se a correção exigir migration, ela é ADITIVA (nova migration numerada a
  partir da última existente), nunca uma edição de migration já aplicada.
- Nenhuma migration destrutiva é adicionada a `db/migrations/` — destrutivas
  ficam em `db/migrations-pending-approval/` com sufixo `.staged`.

Verification: teste da consulta (ou do serviço que a encapsula) com um lead em
cada estado.

## Invariants

- Isolamento multi-tenant preservado em toda consulta nova.
- Nenhuma permissão existente é afrouxada.
- O histórico de agendamentos é append-only: reagendar não apaga o registro
  anterior.
- Nenhum lead perde responsável por efeito da trava (a trava impede troca, não
  causa remoção).
- `db/migrations/` é varrido automaticamente pelo migration-runner no deploy:
  todo `.sql` ali roda sozinho. Nada destrutivo entra nesse diretório.

## Edge Cases

- Lead com vários agendamentos, um `concluido` e outro `confirmado` → definir e
  documentar: a trava vale se QUALQUER agendamento do lead atingiu
  `concluido`/`no_show`.
- Lead sem responsável e com agendamento `concluido` → a trava não pode deixar o
  lead órfão para sempre; documentar que a atribuição inicial (quando não há
  responsável algum) é permitida, e apenas a TROCA é travada.
- Reagendar duas vezes seguidas → segunda vez parte de `confirmado`, fluxo
  normal.
- Reagendamento concorrente com marcação de comparecimento → resolvido pelo lock
  da transação; o resultado final é determinístico e auditado.
- Cargo superior removido no meio da operação → autorização avaliada no início
  da transação.

## Dependencies

Toca backend de scheduling e assignments; e o painel na agenda. A parte de
painel (R3) conflita com a SPEC `agenda-hover-sem-texto` (mesmos arquivos de
agenda) — serializar.

## Affected Areas

- apps/backend/src/modules/scheduling/service.ts (:42, :45, :66-71, :2200)
- apps/backend/src/modules/assignments/service.ts (:35, :106, :669-722, :724-793)
- apps/backend/src/modules/qualification/service.ts (:411)
- apps/backend/src/auth/rbac.ts (leitura de hierarquia)
- apps/backend/src/db/migrations/ (nova migration aditiva, se necessária —
  NOTE o caminho: é `src/db/migrations`, não `db/migrations`)
- apps/panel/app/agenda/agenda-detail-dialog.tsx (:129-131)
- apps/panel/app/agenda/use-agenda-actions.ts

## Non-goals

- Permitir reagendar agendamento `cancelado`.
- Redesenhar o fluxo de distribuição de leads.
- Criar novo modelo de cargos/hierarquia.

## Constraints

- Backend sem `vitest.config.ts`: testes exigem `DATABASE_URL` e
  `PANEL_SEED_PASSWORD` (>=8 chars) no ambiente.
- Migrations destrutivas proibidas em `db/migrations/`.

## Required Tests

- `apps/backend/tests/appointment-reschedule-transitions.test.ts`: matriz de
  transições (R1) e resultado `confirmado` (R2).
- `apps/backend/tests/assignment-attendance-lock.test.ts`: cada rotina
  automática não troca responsável de lead travado (R4); transferência manual por
  dono e por cargo superior passa, por terceiro é 403 (R5).
- Teste de UI da agenda para o botão Reagendar por status (R3).
- Proibido teste-teatro: importar o código de produção, não fazer assert de
  string sobre o arquivo-fonte. Se o comportamento real divergir da SPEC,
  reportar em vez de forçar o teste a passar.

## Definition of Done

- [ ] R1..R6 atendidos e verificados
- [ ] `npm run typecheck` (backend) 0 erros
- [ ] `npx tsc --noEmit` (painel) 0 erros
- [ ] Testes novos passando com env dummy
- [ ] `npx vitest run` (painel) exit 0
- [ ] Nenhuma migration destrutiva em `db/migrations/`
- [ ] Nenhuma permissão afrouxada; isolamento de tenant verificado
