# SPEC: Newave — qualificação comercial curta, aderência e confirmação anti no-show

## Objective

Aplicar as seis mudanças pedidas pelo sócio no `comments.md` à IA da Newave
(tenant `newave-ia`) e ao sistema onde for necessário, de forma que:

1. a qualificação termine com duas perguntas comerciais objetivas (decisor e
   momento) em vez de um interrogatório;
2. só leads com aderência comercial ocupem a agenda;
3. o decisor entre na regra da reunião e apareça para o comercial;
4. exista um estado explícito de CONFIRMAÇÃO solicitada pelo lead depois do
   agendamento;
5. o lembrete do dia vire pedido de confirmação, com rotina de recuperação;
6. o Beto receba um resumo melhor do lead antes da call.

## Source

`comments.md` (raiz de `apps/atendon`), itens 1 a 6.

## Current State (medido, não presumido)

- O prompt de sistema do agente Newave vive **no banco**, não no repositório:
  tenant `newave-ia`, `agent_configs.id = 5b39aeee-8797-4340-ad29-52e01bf54f5f`,
  versão ativa `363e8da1-dbf8-4a0e-a1f3-75d34626f64b` (47.991 bytes).
  O runtime lê da versão ativa via JOIN em
  `apps/backend/src/modules/messages/repository.ts:491-503`,
  `modules/messages/ai-follow-up.ts:481-488` e
  `modules/scheduling/contextual-qualification.ts:151`.
- `agent_config_versions` é imutável por trigger
  (`db/migrations/0057_agent_version_source_immutability.sql`), e
  `agent_configs.active_version_id` é obrigatório
  (`db/migrations/0049_agent_config_versions.sql:90-111`). Publicar prompt novo
  exige aposentar a versão ativa e inserir outra — padrão em
  `db/provision-tripz.ts:139-168`.
- O arquivo-fonte `instrução-newave-ia.md` foi **apagado** do Git no commit
  `f10934f`, mas `db/newave-template.ts:4` ainda tenta lê-lo: `provision:newave`
  está quebrado. O arquivo foi restaurado de `f10934f^` nesta rodada.
- O prompt do banco está **desatualizado** em relação ao arquivo restaurado: o
  banco ainda diz "15 minutinhos", o arquivo (e todo o código de correção em
  `modules/messages/prefilled-context.ts`) já usa "bate-papo de 20 a 40
  minutos". O arquivo restaurado é a fonte correta.
- Qualificação: `qualificar_lead` em `modules/ai-router/tools.ts:117-142` aceita
  `respostas` com lista fechada (`additionalProperties: false`):
  `tempo_mercado`, `faturamento`, `nicho`, `ticket_medio`, `causa_perda_vendas`,
  `possibilidade_investimento`, `cidade`, `decisor_comercial`, `instagram`.
- **Não existe** lembrete temporal de reunião ao lead. O único envio pós-
  agendamento é a entrega imediata do link do Meet
  (`scheduling_meeting_contact_delivery_outbox`, migration 0078; processador em
  `modules/scheduling/meeting-contact-delivery.ts`; fila
  `queue/meeting-contact-delivery-queue.ts`). `enqueueDueAppointmentReminders`
  em `modules/web-push/repository.ts:393` é **push para o time interno**, não
  WhatsApp para o lead.
- `scheduling_appointments` não tem coluna alguma de confirmação do lead; o
  `status` (`confirmado`/`reagendado`/`cancelado`/`concluido`/`no_show`) é
  estado operacional do agendamento, não presença confirmada pelo contato.

## Desired Behavior

O prompt da Newave passa a ter regra de aderência, teto de qualificação com as
duas perguntas comerciais, regra de decisor e um bloco de confirmação de
reunião. O banco ganha estado de confirmação por lead e uma fila de
confirmações agendadas (Momento 1 já coberto pela resposta da IA; Momentos 2 e
3 disparados pelo runtime). O painel mostra decisor e momento de compra ao
comercial.

## Requirements

### R1 — Prompt: duas perguntas comerciais finais (comments.md item 1)

O prompt do agente Newave, na seção de qualificação, passa a declarar que,
depois de nome + negócio + dor, restam no máximo duas perguntas comerciais:
decisor e momento. A pergunta de decisor usa a formulação do sócio; quando a
resposta indicar sócio/terceiro, a IA responde com a frase de benefício e
**encerra o turno sem outra pergunta**. A pergunta de momento é aberta e a IA
classifica internamente em quente/morno/frio, sem revelar. Fica proibido
perguntar diretamente se o contato "está preparado para fechar".

Acceptance Criteria:
- O arquivo `instrução-newave-ia.md` contém uma seção nova de perguntas
  comerciais com as duas perguntas e a regra de encerrar o turno.
- O arquivo contém proibição explícita da pergunta "preparado para fechar".
- A classificação quente/morno/frio está declarada como interna.

Verification:
- `grep -n "depende só de você" instrução-newave-ia.md`
- `grep -n "preparado para fechar" instrução-newave-ia.md`
- `grep -n "colocar isso em prática agora" instrução-newave-ia.md`

### R2 — Prompt: aderência comercial substitui "todo lead agenda" (item 2)

Toda ocorrência da regra "todo lead deve ser conduzido a uma tentativa de
agendamento" passa a exigir aderência comercial. Antes de oferecer horários a
IA verifica: negócio compatível, dor relacionada à solução, capacidade mínima
definida pela operação e intenção real de avaliar a Newave. Lead sem aderência
ou sem momento não ocupa agenda e permanece em acompanhamento/nutrição.

**Invariante que não pode ser quebrada:** a nota de estrelas continua sem poder
descartar ninguém (`nenhuma nota pode descartar o contato`). Aderência é
critério de conversa, não a nota interna.

Acceptance Criteria:
- Não resta no arquivo nenhuma linha afirmando que *todo* lead vai a
  agendamento sem qualificar aderência.
- Existe lista explícita dos quatro critérios de aderência.
- A regra "nenhuma nota pode descartar o contato" continua presente.

Verification:
- `grep -n "todo lead deve ser conduzido" instrução-newave-ia.md` → só na forma
  com "com aderência comercial".
- `grep -n "nenhuma nota pode descartar" instrução-newave-ia.md` → presente.

### R3 — Prompt + dados: participação do decisor (item 3)

O prompt ganha regra de participação de decisores: se o contato depende de
sócio/gerente/outro, a IA tenta organizar a reunião com essa pessoa presente,
**nunca** diz que a reunião não pode acontecer sem ela, e explica o benefício.
No registro do lead a IA informa ao comercial `Decisor: sozinho | sócio | outro`
e `Todos participarão: sim | não confirmado`.

Acceptance Criteria:
- Seção de decisores presente no prompt com a proibição literal.
- `qualificar_lead` aceita duas chaves novas em `respostas`:
  `participacao_decisor` e `momento_compra`.
- Essas chaves sobrevivem à normalização e são persistidas em
  `scheduling_leads.qualification_answers`.
- O painel exibe rótulos legíveis para as duas chaves.

Verification:
- `grep -n "participacao_decisor\|momento_compra" apps/backend/src/modules/ai-router/tools.ts`
- Teste automatizado que envia as duas chaves pelo normalizador e verifica que
  não são descartadas.
- `grep -rn "participacao_decisor" apps/panel` → rótulo presente.

### R4 — Estado de confirmação do lead (item 4)

`scheduling_appointments` ganha estado de confirmação **do contato**, separado
do `status` operacional:

- `contact_confirmation_state TEXT NOT NULL DEFAULT 'nao_solicitada'`
  com CHECK em (`nao_solicitada`, `solicitada`, `confirmada`, `sem_resposta`).
- `contact_confirmation_requested_at TIMESTAMPTZ`
- `contact_confirmation_at TIMESTAMPTZ`

A migration é puramente aditiva (ADD COLUMN IF NOT EXISTS + DEFAULT), sem DROP,
sem backfill destrutivo, e idempotente.

Acceptance Criteria:
- Migration nova aplica em banco limpo (teste `fresh-migrations.integration`)
  e é idempotente ao rodar duas vezes.
- Nenhum `DROP`/`DELETE`/`TRUNCATE` na migration.
- O prompt instrui a IA a, logo após `agendar_reuniao` bem-sucedido, pedir
  confirmação ativa ("me confirma por aqui se posso contar contigo") em vez de
  apenas anunciar o horário.

Verification:
- `grep -niE "drop|delete|truncate" apps/backend/src/db/migrations/0127_*.sql` → vazio.
- `npm test -- fresh-migrations` passa.

### R5 — Confirmação no dia com recuperação (item 5)

Existe um agendador que, para reuniões futuras, enfileira duas janelas de
contato: **T-2h** (confirmação, ou lembrete simples se já confirmado) e
**T-15min** (lembrete se confirmado, última tentativa se não). O disparo é
governado pelo runtime, respeitando a regra do prompt de que a IA nunca infere
sozinha a hora de lembrar.

**Guardrail obrigatório:** o disparo automático nasce **desligado** por feature
flag (`scheduling_meeting_confirmation_v1`, `global_enabled=false`), porque o
usuário não autorizou mandar mensagem a lead real nesta rodada. Nada é enviado
até alguém ligar a flag explicitamente.

Acceptance Criteria:
- Tabela de outbox de confirmação com unicidade por (tenant, appointment,
  momento) — reexecução não duplica mensagem.
- Seleção do texto depende de `contact_confirmation_state`: confirmado → só
  lembra; não confirmado → pede confirmação.
- Feature flag criada com `global_enabled=false`.
- Teste unitário puro (sem banco) da função que escolhe momento + variação.

Verification:
- Teste da função de decisão roda em `vitest` sem Postgres.
- `grep -n "global_enabled" migration` → false.

### R6 — Biblioteca de variações e resumo para o Beto (item 6)

As variações dos Momentos 1, 2 e 3 do `comments.md` viram um módulo tipado no
backend (fonte única, sem texto solto), e o resumo entregue ao comercial passa a
conter decisor, participação e momento de compra.

Acceptance Criteria:
- Módulo exporta as 3 variações de cada um dos 5 cenários do comments.md
  (Momento 1; Momento 2 confirmado/não confirmado; Momento 3 confirmado/sem
  resposta), com `[Nome]` interpolado.
- Seleção de variação é determinística por appointment (mesma reunião → mesma
  variação), para não sortear texto diferente a cada retry.
- Painel exibe decisor e momento no card de qualificação do lead.

Verification:
- Teste unitário conta 15 variações e verifica interpolação do nome.
- Teste verifica determinismo: duas chamadas com o mesmo id retornam o mesmo texto.

## Invariants

- Nenhum outro tenant pode ser afetado: toda migration filtra por
  `tenants.slug = 'newave-ia'` quando toca dados de tenant.
- `agent_config_versions` continua imutável: publicar prompt = aposentar +
  inserir nova versão + apontar `active_version_id`.
- A duração comercial exposta ao contato continua "20 a 40 minutos"
  (`prefilled-context.ts` valida isso em runtime; escrever "15 minutinhos" no
  prompt novo faria o validador rejeitar respostas).
- Nenhuma mensagem automática nova é enviada a lead real sem a flag ligada.
- Nada de deploy nesta rodada sem autorização explícita do usuário.

## Edge Cases

- Reunião reagendada depois de confirmada → confirmação volta para
  `solicitada` (o horário mudou; a confirmação anterior não vale).
- Reunião cancelada → nenhuma confirmação pendente pode disparar.
- Reunião marcada para daqui a menos de 2h → só a janela T-15min faz sentido.
- Lead que responde "sim" fora de qualquer janela → ainda deve poder confirmar.
- Prompt novo maior que o atual → `agent_config_versions.system_prompt` é TEXT,
  sem limite prático.

## Dependencies

- R3 (chaves novas) é independente de R4/R5 (banco/agendador).
- R6 depende de R4 (estado) para escolher a variação certa.
- A publicação do prompt (migration de versão) depende de R1+R2+R3 escritos.

## Affected Areas

- `instrução-newave-ia.md` (restaurado; fonte do prompt)
- `apps/backend/src/db/migrations/0127_*.sql`, `0128_*.sql`
- `apps/backend/src/modules/ai-router/tools.ts`
- `apps/backend/src/modules/qualification/*` (normalizador)
- `apps/backend/src/modules/scheduling/meeting-confirmation.ts` (novo)
- `apps/panel` (rótulos de qualificação)
- testes correspondentes

## Non-goals

- Não reescrever o motor de follow-up por inatividade.
- Não mudar a política de duração comercial.
- Não mexer em outros tenants (Meta Cell, Tripz).
- Não fazer deploy.

## Constraints

- Escopo de commit: `apps/atendon/**` apenas.
- Sem migrations destrutivas.
- Português nas mensagens ao usuário final e nos comentários de domínio.

## Required Tests

- Normalizador aceita `participacao_decisor` e `momento_compra`.
- Decisão de momento/variação de confirmação (unitário, sem banco).
- Determinismo da variação por appointment.
- `fresh-migrations` continua verde.

## Definition of Done

- [ ] R1 a R6 implementados
- [ ] typecheck backend e painel limpos
- [ ] contagem de testes ≥ baseline, sem falha nova
- [ ] migrations sem DROP/DELETE/TRUNCATE
- [ ] flag de disparo automático desligada
- [ ] usuário perguntado sobre deploy
