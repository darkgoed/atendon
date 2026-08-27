# SPEC: Botão Follow-up em /conversas — eliminar o 409 de "falha na aquisição"

## Objective

Fazer o botão "Follow-up" da tela /conversas funcionar de forma confiável,
eliminando o HTTP 409 no caminho feliz e substituindo-o por um contrato honesto
(execução assíncrona) com feedback claro ao usuário.

## Source

comments.md L98: "Botão de follow-up em /conversas esta dando erro 409, falha na
aquisição"

## Current State

Fluxo mapeado:

1. `apps/panel/app/conversas/page.tsx:962-976` — `followUpConversation()` faz
   `POST /conversations/:id/follow-up` com header
   `Idempotency-Key: conversation-follow-up-${conversationId}-${Date.now()}`
   e um estado local `followUpPending` (botão desabilitado em `page.tsx:1439-1441`).
   **A chave JÁ é nova a cada clique** — reuso de chave estável NÃO é a causa.
2. `apps/backend/src/app.ts:2357` — `app.post("/conversations/:id/follow-up", ...)`.
   `apps/backend/src/app.ts:2389` — emite:
   ```ts
   return reply.status(409).send({ ok:false, status: error instanceof Error ? error.message : "conflict" });
   ```
3. `apps/backend/src/modules/messages/ai-follow-up.ts:835` —
   `AiFollowUpProcessResult = "sent" | "not_due" | "cancelled" | "busy"`.
   `apps/backend/src/modules/messages/ai-follow-up.ts:848-852` — **CONDIÇÃO EXATA
   DO 409**: `acquireConversationLock()` retorna `null` após esperar 45 segundos
   pelo lock; `process()` então devolve `"busy"` e o handler responde 409.
4. O lock é Redis, não advisory lock do Postgres —
   `apps/backend/src/modules/messages/conversation-lock.ts`.
   Há heartbeat a cada 20s (`ai-follow-up.ts:853`) cujas falhas são
   silenciosamente ignoradas.
5. A resposta HTTP é genérica (repassa `error.message` cru) e não há telemetria
   do lock, então o operador vê apenas uma falha opaca.

CAUSA RAIZ: a operação é longa (chamada ao modelo, delays humanizados, presença
"composing", envio de múltiplas bolhas, gateway WhatsApp) e está sendo executada
DENTRO da requisição HTTP síncrona, segurando o lock Redis da conversa o tempo
todo. Qualquer outro processamento da mesma conversa (inclusive o follow-up
automático do worker) segura o lock, e a requisição do botão espera 45s e
desiste com 409. Um heartbeat que falhe silenciosamente agrava o quadro. Ou
seja, o 409 é consequência previsível do desenho síncrono atual, não um caso
raro de corrida.

## Desired Behavior

Clicar em "Follow-up" enfileira o envio e devolve imediatamente uma resposta de
aceite. A UI mostra progresso e o resultado final. O usuário não vê erro quando
o sistema está simplesmente trabalhando. Cliques repetidos não geram envio
duplicado.

## Requirements

### R1 — Endpoint responde de forma assíncrona

Description: `POST /conversations/:id/follow-up` deixa de executar o
processamento inline e passa a agendar/enfileirar o trabalho.

Acceptance Criteria:
- O endpoint responde `202 Accepted` com um identificador da solicitação quando
  o trabalho é aceito.
- O endpoint NÃO retorna 409 apenas porque o processamento está em andamento.
- A resposta é emitida em tempo de requisição normal (não espera o envio ao
  WhatsApp concluir).
- O processamento efetivo continua usando o `AiFollowUpProcessor` existente —
  nenhuma lógica de follow-up é reimplementada.

Verification: teste de integração do handler afirmando 202 e ausência de espera
pelo resultado do processador.

### R2 — Idempotência real por conversa

Description: cliques repetidos ou retries de rede não produzem dois follow-ups.

Acceptance Criteria:
- Uma segunda requisição com a MESMA `Idempotency-Key` enquanto a primeira está
  em andamento retorna `202` com o MESMO identificador de solicitação — não 409.
- Uma segunda requisição com a mesma chave após a conclusão retorna o resultado
  já registrado, sem reenviar mensagem.
- A chave de idempotência enviada pelo painel JÁ inclui `Date.now()`
  (page.tsx:962-976), portanto cada clique gera chave nova. Mantenha esse
  comportamento — não regrida para chave estável derivada só do conversationId.
- Nenhuma tabela nova é criada: reutiliza `modules/messages/idempotency.ts`.

Verification: teste que dispara duas chamadas concorrentes com a mesma chave e
afirma um único envio.

### R3 — 409 reservado a conflito real e traduzido na UI

Description: se ainda houver caso genuinamente conflitante, ele é comunicado com
mensagem compreensível.

Acceptance Criteria:
- O corpo de erro traz um código estável legível por máquina (ex.:
  `conversation_busy`), não a mensagem crua de `Error.message`.
- O painel mapeia esse código para uma mensagem em português clara, sem expor a
  string técnica "busy" nem "falha na aquisição".
- Estados `not_due` e `cancelled` NÃO são apresentados como erro: são informados
  como estado ("não há follow-up pendente para esta conversa" / "sequência
  encerrada"), com HTTP 200/202 apropriado.

Verification: teste de mapeamento de erro no painel.

### R4 — Feedback de progresso no painel

Description: o botão reflete o ciclo de vida real da operação.

Acceptance Criteria:
- Ao clicar: botão desabilitado com indicação de "enviando"/"na fila".
- Ao receber 202: a UI informa que o follow-up foi enfileirado.
- O botão é reabilitado quando a operação termina ou falha — nunca fica travado
  permanentemente em `followUpPending`.
- Falha de rede reabilita o botão e permite nova tentativa (com chave de
  idempotência nova, conforme R2).

Verification: teste de UI simulando 202, erro e timeout.

### R5 — Heartbeat do lock não falha em silêncio

Description: falhas de `extendConversationLock` passam a ser observáveis.

Acceptance Criteria:
- `ai-follow-up.ts:853` registra log de erro (com conversationId) quando o
  heartbeat falha, em vez de descartar a rejeição.
- O intervalo do heartbeat é limpo em TODOS os caminhos de saída, inclusive erro
  (nenhum `setInterval` vazando).

Verification: teste unitário que força falha do heartbeat e afirma o log e o
`clearInterval`.

## Invariants

- Isolamento multi-tenant: a solicitação só pode agir sobre conversa do tenant
  da sessão. Nenhuma verificação de tenant é afrouxada.
- A permissão exigida hoje pelo endpoint é mantida — não afrouxar.
- Nenhuma mensagem é enviada ao contato mais de uma vez pelo mesmo clique.
- Se o envio falhar, o lead NÃO é movido para o estágio de follow-up.

## Edge Cases

- Redis indisponível → responder erro explícito de indisponibilidade (503), não
  409 nem 500 genérico.
- Conversa já resolvida/encerrada → estado informado, não erro.
- Dois operadores diferentes clicando na mesma conversa quase ao mesmo tempo →
  um único envio; o segundo recebe o mesmo identificador de solicitação.
- Processo do worker reiniciado no meio do envio → o lock expira por TTL e não
  fica travado para sempre.

## Dependencies

Toca `apps/backend/src/app.ts` — não pode rodar em paralelo com qualquer outra
SPEC que edite esse arquivo.

## Affected Areas

- apps/backend/src/app.ts (handler de `/conversations/:id/follow-up`)
- apps/backend/src/modules/messages/ai-follow-up.ts
- apps/backend/src/modules/messages/idempotency.ts
- apps/backend/src/modules/messages/conversation-lock.ts
- apps/panel/app/conversas/page.tsx

## Non-goals

- Reescrever o AiFollowUpProcessor ou a lógica de IA.
- Criar tabela nova de fila.
- Alterar o design da tela /conversas.

## Constraints

- Backend sem `vitest.config.ts`: rodar testes com `DATABASE_URL` e
  `PANEL_SEED_PASSWORD` (>=8 chars) no ambiente.
- Não introduzir dependência nova de fila.

## Required Tests

- `apps/backend/tests/conversation-follow-up-endpoint.test.ts`:
  202 no caminho feliz; mesma chave concorrente → um envio; código de erro
  estável; tenant alheio → negado.
- Teste unitário do heartbeat (R5).
- Teste de UI no painel para R3/R4.
- Proibido "teste-teatro": os testes importam o código de produção, não fazem
  assert de string sobre o arquivo-fonte.

## Definition of Done

- [ ] R1..R5 atendidos e verificados
- [ ] Caminho feliz nunca retorna 409
- [ ] `npm run typecheck` (backend) 0 erros
- [ ] `npx tsc --noEmit` (painel) 0 erros
- [ ] `npx vitest run` do backend sem NOVAS falhas além das de conexão
      preexistentes
- [ ] `npx vitest run` (painel) exit 0
- [ ] Nenhuma permissão ou verificação de tenant afrouxada
