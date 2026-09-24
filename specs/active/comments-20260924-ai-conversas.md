# SPEC: comentários atuais — agendamento, mídia e copiloto

## Objective
Entregar cada intenção das linhas 1–7 do `comments.md` atual, com correções causais, preservando a arquitetura multi-tenant, as permissões e o comportamento existente por padrão.

## Source
`comments.md` (2026-09-24, 7 linhas). Diagnóstico: `.hermes/state/comments-spec-loop/20260924/findings.md`. Não reutilizar o progress.md de rodada anterior como evidência.

## Current State
- Confirmação do contato tem estados e outbox próprios; a IA faz o primeiro pedido após agendar e o worker envia lembretes posteriores. A flag `scheduling_meeting_confirmation_v1` já existe (desligada por padrão) e bloqueia o worker, mas ainda não controla o pedido no turno da IA. Só ROOT gerencia overrides atualmente.
- Imagens/figurinhas das conversas e miniaturas da aba Mídia abrem em nova aba.
- O agente permite lista de ferramentas; backend rejeita nomes fora do catálogo vigente, painel reenvia lista recebida da persistência sem reconciliar nomes legados.
- Não foi demonstrado fluxo de geração manual de resposta contextual sem envio; a investigação dos seams backend está pendente.
- O caso de link de mídia identificado pelo usuário ainda não foi verificado em banco/provedor; não assumir causa.

## Desired Behavior
Configuração tenant-scoped controla os pedidos de confirmação ao contato em reuniões criadas pela IA, sem impedir o agendamento. Imagens abrem num Dialog autenticado dentro da página. Operador autorizado obtém sugestão contextual sob demanda e pode editar, regenerar ou ignorar sem autoenvio. Ferramentas obsoletas não impedem salvar. Link de mídia e criação de fluxo de robô são reproduzidos e corrigidos conforme a causa-raiz confirmada.

## Requirements

### R1 — Confirmação de agendamentos por IA configurável
Uma opção em Configurações permite habilitar/desabilitar pedidos de confirmação ao contato nas reuniões criadas pela IA, reutilizando `scheduling_meeting_confirmation_v1` por tenant (sem segunda flag/schema). O default desligado da flag permanece desligado para os lembretes; o comportamento do primeiro pedido da IA precisa se alinhar à flag, inclusive com prompts legados que mandam pedir confirmação. A opção NÃO desativa a criação do agendamento, notificação factual nem fluxo manual de agendamento. Criar rota de alteração para gestor do próprio tenant sem conceder acesso ROOT amplo; verificar agendamentos existentes, reagendamentos e jobs pendentes. Não duplicar confirmação.

Acceptance Criteria:
- Operador com permissão de gestão altera a opção e recarrega com valor preservado; sem permissão não altera.
- Ligado, uma reunião criada pela IA pede confirmação e habilita lembretes; desligado, nenhum novo pedido de confirmação sai por IA ou worker para esse tenant e a reunião permanece criada; resposta factual (dia/hora/link) continua.
- Tenant B não herda a opção de A; um agendamento manual mantém seu fluxo anterior.
Verification:
- Teste integração de configuração, isolamento e outbox + teste do painel com clique/reload; exercício controlado de criação pelo tool executor.

### R2 — Imagens em modal
Trocar somente links de imagens/figurinhas do chat e da aba Mídia por Dialog existente; usar URL autenticada atual. Não trocar o download de documentos ou links externos. Preservar alt/legendas.

Acceptance Criteria:
- Clique abre imagem no `role=dialog` com a mesma src sem nova aba; X, Escape e backdrop fecham e devolvem o foco; teclado acessível.
- Zero `target="_blank"` nos ramos de imagem/figurinha/miniaturas, sem mudança de layout ou regressão em áudio/vídeo.
Verification:
- Vitest jsdom de mensagem e aba Mídia, typecheck/lint/build e prova em browser com mídia autenticada/fixture.

### R3 — Copiloto de IA sob demanda
Uma ação no composer solicita sugestão a partir do prompt do agente aplicável à conexão e do histórico integral da conversa que o servidor autoriza ler. Nunca executar ferramenta mutante, nunca publicar mensagem automaticamente e nunca gerar sem clique. A resposta substitui/preenche somente rascunho editável após confirmação do operador quando já houver texto; regenerar envia a sugestão anterior para produzir uma alternativa; evitar chamadas concorrentes. Se o histórico ultrapassar o limite do modelo, a interface/contrato deve informar explicitamente a limitação, sem alegar leitura completa. Respeitar quota/custos e falhas do provedor pelos mecanismos existentes.

Contrato proposto: `POST /conversations/:id/copilot-suggestion` (permite somente `conversations.reply` e `conversationScopeCondition`), corpo `{previous_suggestion?: string}` com tamanho limitado; resposta `{suggestion: string, context_complete: boolean, messages_used: number, messages_total: number}`. `context_complete=false` sempre que nem todas as mensagens textuais couberem no orçamento seguro do modelo; nunca usar o CTE de histórico de 40 mensagens como se fosse a conversa completa. Não gravar sugestão em `messages`, `usage_logs` segue o padrão existente, `tools: []` e nenhum `sendText`/sendMedia. Reavaliar se o caso de uso exige conversar via Instagram e seguir o gate do canal atual; não prometer capacidade de envio em janela fechada.

Acceptance Criteria:
- Uma geração por clique com conversa e tenant corretos, prompt vigente compartilhado/por conexão e mensagens recuperadas com paginação até o limite explicitamente sinalizado; nenhum dado de outro tenant entra no prompt.
- Sugestão é editável e não sai ao contato; regeneração recebe o texto anterior, não o repete literalmente na resposta de sucesso; ausência de permissão/agente/provedor gera erro acionável.
- Zero consumo de IA em render, digitação, troca de conversa ou revalidação; resposta atrasada da conversa anterior não altera composer da atual.
Verification:
- Integração backend com gateway mockado e dois tenants; vitest do composer com controle de chamadas e race; build/browser real.

### R4 — Ferramentas desconhecidas no agente
Reproduzir GET→PUT `/agent` com `enabledTools` contendo nome legado. A UI reconcilia a lista persistida com `available_tools` do servidor, avisa o usuário dos nomes obsoletos e envia só os nomes válidos no PUT; o backend MANTÉM validação estrita para chamadas arbitrárias (não filtra silenciosamente entrada maliciosa). Não habilitar tools novas por acidente nem apagar as antigas sem aviso.

Acceptance Criteria:
- Caso GET com nome legado salva pela UI sem erro de `enabledTools` após aviso; seleção válida existente preservada, desconhecidas não são executadas; PUT direto malformado continua rejeitado; outras falhas não são engolidas nem reportadas como sucesso.
- Configuração por conexão e compartilhada respeitam tenant e permissões.
Verification:
- Teste RED/GREEN vitest da tela com GET contendo tools legadas seguido de PUT reconciliado; teste de rejeição direta pelo backend já existente/estendido; typecheck/lint.

### R5 — Link de mídia do contato citado
Investigar, com acesso autorizado READ-ONLY e sem exibir conteúdo privado, os metadados da mensagem/conversa citadas: direção, tipo, origem do corpo/link, autenticação da rota de mídia, logs de envio e capacidade do gateway. Reproduzir em fixture somente após identificar a origem do URL. Corrigir o caminho emissor comum se a aplicação tiver enviado um endereço interno inacessível ao destinatário; não transformar endpoint privado em público nem criar link sem autenticação por conveniência.

Acceptance Criteria:
- Evidência de se o link foi enviado ao contato pela aplicação, recebido do contato, ou exibido só no painel; formato e status de acesso verificados sem vazar mídia.
- Se defeito confirmado, teste RED/GREEN prova que destinatário recebe mídia válida (ou falha explicitamente) e que outro tenant não acessa a rota.
Verification:
- Consulta somente leitura + teste integração de mensagem/media/gateway e E2E controlado quando possível.

## Invariants
Tenant em toda consulta/mutação; papéis e permissões existentes; CAS de fluxos; quotas de IA e gastos; não armazenar/expor texto de conversa em logs; URLs privadas de mídia continuam autenticadas; não alterar semântica de confirmação para agendamentos humanos por acidente; nenhum deploy sem pedido expresso.

## Edge Cases
Agente por conexão vs compartilhado; prompt ausente; mídia ausente/expirada; múltiplas imagens; conversa trocada durante resposta; regeneração após erro; reunião reagendada/cancelada; confirmação já enfileirada; sessão de WhatsApp arquivada; nomes de tools de releases antigas.

## Dependencies and Implementation Order
1. Reproduções e contratos reais de R1/R3/R4/R5; fluxo de robô em SPEC de auditoria; comparar crm-whatsapp apenas no comportamento de robô inexistente/defeituoso.
2. R4 pela UI (backend mantém validação estrita), depois backend R1 e R3 conforme integração real do executor; cada mudança com teste focal e tenancy. R5 após identificar direção/origem.
3. UI R1/R2/R3 EXCLUSIVAMENTE por Hermes com `--provider anthropic -m claude-opus-5-5`; backend separado, contratos pré-escritos antes de despachar UI. Nenhum OpenRouter em UI/UX.
4. Gates completos, revisão Ponytail FULL no diff final, revisão independente e Jev scope-drift/completeness; corrigir reprovações, depois auditoria transversal da SPEC irmã.

## Affected Areas
`apps/backend/src/modules/{scheduling,ai-router,messages,qualification}`, `apps/backend/src/app.ts`, migrations e tests relacionados; `apps/panel/app/{agente,configuracoes,conversas,fluxos}`, `apps/panel/components/{conversation-message-media,conversation-contact-panel,conversation-composer,ui/dialog}`, testes do painel. Escopo exato a ajustar por causa-raiz, não alterar todos por padrão.

## Non-goals
Redesign; sugestão automática; execução de tools pela sugestão; exposição anônima de mídia privada; recriar o robô herdado do crm-whatsapp; limpar TODOs não relacionados sem repro.

## Constraints
Sem alterar `comments.md`; sem commit/push/deploy solicitado; sem credenciais/PII em relatórios; bancos descartáveis para integração; backend/UX com posse exclusiva de arquivos. Jev avalia decisão/risco/completude mas não substitui teste; Ponytail FULL exige menor diff correto.

## Required Tests
Reproduções RED antes dos fixes; integração backend com tenant A/B, quota, sessão e negativa/positiva; vitest painel; `npm run typecheck`, `npm run lint`, `npm run build`, `npm run test:deploy`, suites relevantes em DB descartável e E2E browser das superfícies tocadas.

## Definition of Done
- [x] R1–R5 têm contrato/causa e aceite local verificados ou limite externo documentado na matriz (`R5` é imagem recebida, não URL enviada; fluxo da conta afetada é pendência da auditoria irmã).
- [ ] Ausência universal de efeitos colaterais de permissão/tenancy, geração espontânea, gasto indevido ou URL pública não pode ser provada por testes finitos; controles positivos/negativos e lacunas constam do relatório.
- [x] Gates reais passam com contagens e exit codes em `progress.md`/`RELATORIO.md`.
- [x] Jev intake/decisões/scope-drift/completude registrados, Ponytail FULL e revisões independentes executadas; achados aceitos corrigidos e revalidados localmente.
- [x] Auditoria transversal irmã executada e documentada em `specs/active/auditoria-transversal-20260924.md` e `audit.md`; objetivo não encerrado na linha 7.
