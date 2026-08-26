# SPEC: Botão Follow-up nas conversas

## Objective
Adicionar, na tela de conversas, um botão **Follow-up** ao lado de **Resolver**. Ao acioná-lo, o backend deve gerar uma mensagem curta de follow-up usando o contexto da conversa, enviá-la imediatamente pelo mesmo caminho de IA/WhatsApp já existente e mover o lead para o estágio técnico `follow_up`, sem quebrar isolamento entre tenants nem produzir estado parcial.

## Source
comments.md

Item da linha 7:
> FEATURE: Ter um botão ao lado de resolver em conversas, chamado Follow-up, quando a pessoa clica no follow-up, na hora a IA dispara um follow-up de acordo com o contexto abordado e o status do lead cai para follow-up

## Current State
- `apps/panel/app/conversas/page.tsx:970-981` implementa Resolver: confirma a ação, chama `PATCH /conversations/:id/resolve` e revalida lista/thread. O botão é renderizado em `:1421-1423`, condicionado a `canReply` e conversa aberta.
- O status picker existente está em `apps/panel/components/conversation-status-picker.tsx`. Ele carrega `GET /organization/pipeline`, calcula apenas transições configuradas e move lead com `PATCH /organization/leads/:leadId/stage`, enviando `stage_id` e `expected_updated_at` (e eventual payload comercial). Permissão: `leads.update_status`; capability: `case_organization_v1`/`pipeline_v1`.
- `apps/backend/src/app.ts:2080+` mostra as rotas de conversa. `POST /conversations/:id/reply-with-ai` exige `conversations.reactivate`, valida tenant e escopo com `resolveCaseScope`, trava a conversa e a última mensagem, reativa IA e reenfileira uma mensagem inbound para `enqueueInboundRecovery`; responde `202 {ok:true,queued:true}`. Esse endpoint só recupera uma última mensagem do contato e não é, por si só, um follow-up manual.
- Resolver/reabrir são operações de conversa (`PATCH /conversations/:id/resolve` e `PATCH /conversations/:id/reopen`), distintas de estágio de lead.
- O caminho de geração/envio existente está em `apps/backend/src/modules/messages/process-message.ts`: usa `AiRouter`, contexto/histórico, `gateway.sendText(...)` via `MessageGateway`, e persiste resposta com `repository.recordAgentReply(...)`. Esse caminho também publica progresso e usa lock de conversa. Não criar um segundo cliente WhatsApp nem persistir mensagens diretamente fora do repository.
- Já existe suporte de follow-up automático em `apps/backend/src/modules/messages/ai-follow-up.ts` e `apps/backend/src/queue/ai-follow-up-queue.ts`. `followUpSystemPrompt`, `followUpContinuityContext`, validadores de repetição e `AI_FOLLOW_UP_NOT_NEEDED_MARKER` codificam o contexto/regras de geração. A agenda usa a tabela `ai_follow_up_schedules`; as configurações por tenant ficam em `tenant_ai_settings` (`ai_follow_up_enabled`, `ai_follow_up_max_count`, `ai_follow_up_delays_minutes`, `ai_follow_up_delivery`). O novo clique é imediato e não deve depender de aguardar essa fila agendada.
- O pipeline usa `pipeline_stages` e `scheduling_leads.pipeline_stage_id`; o status técnico exato já existente é `follow_up`. `apps/backend/tests/commercial-journey.test.ts` confirma `LEAD_TECHNICAL_STATUSES` contendo `follow_up` e regras de transição; `apps/backend/src/modules/dashboard/service.ts` também consulta `lead.status='follow_up'`. A movimentação atual é implementada por `apps/backend/src/modules/organization/routes.ts:230-236` e serviços/imports adjacentes, com `leads.update_status`, controle de versão e eventos.
- O banco contém ainda `lead_qualifications`, `scheduling_lead_events`, `messages`, `conversations` e `audit_logs`; qualquer atualização deve filtrar sempre por `tenant_id`.

## Desired Behavior
1. Em conversa aberta, usuário autorizado vê **Follow-up** imediatamente ao lado de **Resolver**.
2. Um clique dispara uma única operação backend síncrona do ponto de vista da API: obter contexto válido, gerar a mensagem com as regras de follow-up, enviá-la pelo WhatsApp e, somente após confirmação do envio/persistência da resposta, mover o lead associado ao estágio `follow_up`.
3. A mensagem aparece no thread como saída da IA e o lead retorna com `pipeline_stage_id` do estágio cujo `technical_status='follow_up'`.
4. Falha de geração ou envio não altera o estágio. Falha ao mover o estágio após envio deve ser tratada como estado recuperável/compensável, com registro de operação e retry seguro; nunca responder sucesso como se ambas as ações tivessem terminado.

## Requirements
### R1
Implementar botão **Follow-up** ao lado de Resolver em `apps/panel/app/conversas/page.tsx`, com estado pending, feedback de erro e revalidação de lista/thread.

Acceptance Criteria:
- O botão aparece somente para conversa aberta, usuário com a permissão definida para a ação e lead associado; fica visualmente adjacente a Resolver.
- Enquanto a requisição está em andamento, o botão fica desabilitado e um segundo clique não cria outra requisição.
- Sucesso atualiza thread, lista e estágio sem exigir refresh manual; erro é visível e não deixa loading preso.

Verification:
- Teste de UI/contrato lê o header e verifica a ordem Follow-up/Resolver e que o botão chama o endpoint novo.
- Teste manual ou automatizado simula sucesso e erro, incluindo duplo clique.

### R2
Criar endpoint autenticado, recomendado `POST /conversations/:id/follow-up`, com schema de params/body e resposta explícita contendo `ok`, `message_id`, `lead_id`, `pipeline_stage_id` e status da operação.

Acceptance Criteria:
- O endpoint exige sessão e permissão de atendimento apropriada (a definir conforme matriz existente; no mínimo não pode ser menos restritiva que `conversations.reactivate`), resolve `tenantId` da sessão e aplica `resolveCaseScope`/case access.
- A consulta de `conversations`, lead e `pipeline_stages` usa `id` + `tenant_id`; acesso a conversa de outro tenant retorna 404/erro indistinguível de inexistente.
- O estágio alvo é localizado pelo `technical_status='follow_up'`, não por nome traduzido nem por ID fixo; ausência/arquivamento/configuração inválida retorna erro controlado.

Verification:
- Testes de integração cobrem usuário sem permissão, tenant errado, escopo de caso, conversa sem lead/WhatsApp e ausência do estágio.

### R3
Reusar geração e envio existentes, com histórico limitado e protegido contra prompt injection.

Acceptance Criteria:
- A geração usa `AiRouter`/configuração ativa do tenant e as regras reutilizáveis de `apps/backend/src/modules/messages/ai-follow-up.ts` (incluindo continuidade, mensagem curta, não inventar fatos e marcador `[[NO_FOLLOW_UP_NEEDED]]`).
- O envio usa `MessageGateway.sendText(sessionId, contactJid ?? contactPhone, text)` e a persistência usa o repository/padrão de `process-message.ts`, incluindo `external_message_id`, remetente `agent` e `tenant_id`.
- Nunca são usados dados, prompt, configuração ou sessão WhatsApp de outro tenant; segredos continuam protegidos.
- Se a IA retornar `AI_FOLLOW_UP_NOT_NEEDED_MARKER`, nada é enviado e o estágio não muda; a resposta identifica `not_needed`.

Verification:
- Testes mockam AiRouter e gateway, verificando contexto/histórico, destino, persistência e ausência de envio no marcador.

### R4
Mover o lead para o estágio `follow_up` apenas como parte da operação concluída, reaproveitando domínio de pipeline.

Acceptance Criteria:
- Após envio confirmado e mensagem persistida, a operação atualiza `scheduling_leads.pipeline_stage_id` e o status técnico resultante é `follow_up`, respeitando transições, `expected_updated_at`, `leads.update_status` e eventos/auditoria já usados pelo pipeline.
- A operação não muda `conversations.status` para resolvida automaticamente; Follow-up é uma ação de saída e mudança de estágio, não substituto de Resolver.
- Se a mensagem não foi enviada/persistida, o lead permanece no estágio anterior.

Verification:
- Teste de integração consulta `scheduling_leads`, `pipeline_stages` e `scheduling_lead_events` após sucesso e após falha.

### R5
Garantir idempotência e consistência em concorrência.

Acceptance Criteria:
- O endpoint aceita `Idempotency-Key` conforme `apps/backend/src/modules/messages/idempotency.ts` (`8-128` caracteres, regex definida) e vincula a chave a tenant, conversa e fingerprint do payload.
- Repetição da mesma chave devolve o mesmo resultado sem nova geração/envio; chave reutilizada para outro alvo retorna conflito.
- Duplo clique com chaves distintas também é serializado por lock/claim transacional da conversa e não produz duas mensagens de follow-up para a mesma ação/contexto.
- A transação/registro da operação suporta estados `processing`, `sent`, `stage_updated`, `failed` (ou equivalente) e retry não reenvia uma mensagem já confirmada.

Verification:
- Testes concorrentes executam duas requisições e verificam exatamente uma chamada ao gateway e uma mensagem agent; testam retry após timeout e replay da mesma chave.

### R6
Tratar erros de IA, WhatsApp, estágio e persistência com recuperação observável.

Acceptance Criteria:
- Falha de IA, timeout, resposta inválida, sessão ausente ou falha do gateway retorna erro HTTP apropriado, registra erro/auditoria e não move o lead.
- Falha após o envio, antes da mudança de estágio, não é mascarada: fica registrada para reconciliação/retry idempotente (reusar padrões de `operations/event-reconciliation.ts` quando aplicável), e a API não declara operação totalmente concluída.
- Auditoria inclui tenant, usuário, conversa, lead, idempotency key e resultado sem incluir prompt/segredos desnecessários.

Verification:
- Testes injetam cada falha e verificam banco, resposta HTTP, logs/auditoria e ausência de duplicidade em retry.

## Invariants
- Isolamento por `tenant_id` e escopo de casos é obrigatório em toda leitura, lock, escrita e retry.
- Não enviar texto gerado por IA sem validação/sanitização e não executar ferramentas nem alterar cadastros durante o modo follow-up.
- Uma ação lógica gera no máximo uma mensagem e uma transição de estágio.
- Resolver continua chamando `PATCH /conversations/:id/resolve` e mantém comportamento atual.

## Edge Cases
- Conversa fechada, sem `session_id`, sem lead correspondente, contato sem telefone/JID ou agente/configuração IA inativa.
- Última mensagem já é do atendimento/IA, outra IA está processando, conversa recebeu nova mensagem durante a geração, ou o lead já está em `follow_up`.
- Estágio `follow_up` arquivado, múltiplos estágios com mesmo technical status, transição não permitida ou `updated_at` alterado durante a operação.
- IA decide não enviar, retorna conteúdo vazio/repetitivo, excede limite, ou WhatsApp aceita envio mas a confirmação de persistência falha.

## Dependencies
- `AiRouter`, `MessageGateway`, `process-message.ts`, `ai-follow-up.ts`, repository de messages e lock de conversa.
- Pipeline/organization services e tabelas `scheduling_leads`, `pipeline_stages`, `scheduling_lead_events`.
- Autorização de sessão/capabilities, `audit_logs`, e mecanismo de idempotência/reconciliação.

## Affected Areas
- `apps/panel/app/conversas/page.tsx`
- `apps/panel/components/conversation-status-picker.tsx` (somente se compartilhar/ajustar resolução de estágio; não duplicar o fluxo)
- `apps/backend/src/app.ts` ou módulo de rotas de conversas
- `apps/backend/src/modules/messages/process-message.ts`
- `apps/backend/src/modules/messages/ai-follow-up.ts`
- `apps/backend/src/modules/messages/idempotency.ts` e lock/repository relacionados
- `apps/backend/src/modules/organization/routes.ts` e serviço de pipeline
- migrações/tabelas para operação idempotente, se o padrão existente não puder ser reutilizado
- testes do panel e backend de conversas, messages, organização/pipeline e multi-tenant

## Non-goals
- Não implementar Follow-up com áudio, imagem ou outros anexos (item separado da linha 11).
- Não alterar o agendamento automático da tabela `ai_follow_up_schedules` nem as configurações de sequência.
- Não substituir, renomear ou remover Resolver, reabrir, pausa da IA ou transições manuais do pipeline.
- Não alterar `comments.md`, layout geral de leads/agenda ou outras features.

## Constraints
- Manter TypeScript, Fastify e padrões de validação/erros do monorepo.
- Não chamar diretamente o provedor WhatsApp fora de `MessageGateway`.
- Não depender de nome visual traduzido para identificar o estágio.
- Não considerar `202 queued` suficiente para sucesso desta feature: o contrato deve deixar inequívoco quando mensagem e estágio foram concluídos ou quando há operação pendente.

## Required Tests
- Panel: renderização/permissão/ordem, pending/duplo clique, sucesso, erro e revalidação.
- Backend unitário: prompt/contexto, marcador no-send, sanitização, idempotência/fingerprint e lock.
- Backend integração: sucesso ponta a ponta com mocks do IA/WhatsApp; falhas de IA/gateway/persistência/pipeline; conversa fechada e concorrência.
- Segurança: autorização, case scope e tentativas cross-tenant para conversa, lead, estágio e idempotency key.
- Regressão: `npm test`, `npm run lint`, `npm run typecheck`, `npm run build`.

## Definition of Done
- [ ] Botão Follow-up aparece ao lado de Resolver somente nos casos autorizados.
- [ ] Endpoint autenticado gera e envia uma única mensagem usando o caminho IA/WhatsApp existente.
- [ ] Mensagem é persistida e aparece no thread como saída da IA.
- [ ] Lead muda para `pipeline_stages.technical_status='follow_up'` somente após envio confirmado.
- [ ] Falhas não deixam mudança parcial não observável; retry/reconciliação é seguro.
- [ ] Idempotência, lock e duplo clique foram testados.
- [ ] Isolamento multi-tenant e case scope foram testados.
- [ ] Testes, lint, typecheck e build passam.
