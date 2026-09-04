# A3 — Pipeline de IA e contabilização de uso

## 1. Pontos efetivos de chamada a LLM

- **Atendimento principal, transcrição de áudio:** `apps/backend/src/modules/ai-router/openrouter.ts:367-453`, método `OpenRouterClient.transcribe`; faz POST em `/audio/transcriptions` (`:383-397`), extrai uso (`:403-422`) e chama `onUsage` (`:424-433`).
- **Atendimento principal, análise de imagem/documento/figurinha:** `apps/backend/src/modules/ai-router/openrouter.ts:456-575`, método `analyzeMedia`; faz POST em `/chat/completions` (`:494-518`) e persiste o callback de uso (`:525-555`).
- **Atendimento principal, geração conversacional e tool loop:** `apps/backend/src/modules/ai-router/openrouter.ts:578-749`, método `complete`; cada iteração do estado (inicial, continuação de ferramenta, retry ou síntese final) emite POST em `/chat/completions` (`:723-749`). O uso de cada request é journaled pelo `onUsage` e o orçamento do turno é acumulado.
- **Chamadores do atendimento:** `apps/backend/src/modules/messages/process-message.ts:1126-1144` transcrição; `:1161-1184` mídia/figurinha; `:1435-1439` cria o recorder tenant/conversation/message; `:1464-1482` geração especial de confirmação; `:1526-1537` busca de produto; `:1543-1554` busca de contexto; `:2015-2020` geração final `inbound_reply`.
- **Follow-up automático:** `apps/backend/src/modules/messages/ai-follow-up.ts` contém o motor e o claim/agendamento (`:287-350`); a execução do job injeta `AiRouter` e gera a mensagem com `complete` (a chamada é no trecho posterior do arquivo, dentro do executor do follow-up). Deve ser um consumidor separado, mas com o mesmo recorder de uso.
- **Tripz/Zulu:** `apps/backend/src/modules/tripz-ai/ai/openrouter-client.ts:513-516` faz POST em `/chat/completions`; o cliente cria e persiste um registro por provider request (`:503-510`). Orquestração em `apps/backend/src/modules/tripz-ai/ai/orchestrator.ts:482-485`; runtime liga `onUsage` ao repositório em `apps/backend/src/modules/tripz-ai/runtime.ts:140-146`.

Não há chamada direta identificada a SDK OpenAI/Anthropic: os modelos OpenAI/Anthropic são selecionados como slugs, mas o transporte é OpenRouter (`openrouter.ts:494`, `:723`; Tripz `openrouter-client.ts:513`).

## 2. Debounce/agregação

O ponto exato é `apps/backend/src/modules/messages/humanizer.ts:321-352`, funções `debounceInbound` e `flushDebounce`. As mensagens do mesmo `key` são acumuladas (`:327-334`), concatenadas por newline (`:346-351`) e apenas o último waiter recebe `process: true` (`:351`); os anteriores recebem `false`. A entrada no pipeline está em `apps/backend/src/modules/messages/process-message.ts:1035-1053`, usando chave `${tenantId}:${contactJid ?? contactPhone}`. Portanto quatro mensagens rápidas viram um texto agregado e uma única continuação para geração. O lock por conversa serializa turnos posteriores (`process-message.ts:1056-1062`).

## 3. Ponto único correto para “1 interação de IA”

O ponto correto é **a conclusão bem-sucedida de um turno lógico**, no nível do orquestrador de atendimento (`MessageProcessor`), imediatamente após `ai.complete` retornar a resposta final, e não em cada POST do OpenRouter. A razão é que `OpenRouterClient.complete` pode fazer várias gerações no mesmo turno: o índice começa em `:715` e o loop chama o provider em `:723`; há tool continuation, retries e final synthesis (`:620-625`, `:638-669`). Contar no transporte duplicaria uma interação quando há ferramentas/retries. O recorder de tokens/custo continua no nível de provider request; um contador de franquia deve ser emitido uma vez quando o resultado final é aceito/enviado, com uma chave idempotente baseada em `requestId`/message/turn. Para transcrição/análise standalone e follow-up, cada operação lógica concluída é uma interação (também uma vez, apesar de retries internos).

## 4. Registro existente

Existe `usage_logs`, criada em `apps/backend/src/db/migrations/0001_core.sql:56-71`, com `tenant_id`, conversa, `ai_model`, `input_tokens`, `output_tokens`, `cost_usd` e índice tenant/data. `apps/backend/src/db/migrations/0010_usage_provider_request.sql:1-6` acrescenta `provider_request_id` e unicidade para idempotência de provider request. `apps/backend/src/db/migrations/0102_ai_provider_observability.sql:1-25` acrescenta `message_id`, `request_id`, `processing_attempt`, `provider_request_index`, `call_reason`, duração, ferramentas, `reasoning_tokens`, `cached_input_tokens`, `cache_write_input_tokens` e métricas de caracteres. Assim, input/output/cached/cost/model já são suportados (cached separado em input e cache-write); não existe ainda campo explícito de “1 interação lógica” nem período de cobrança/franquia.

A persistência do atendimento está em `apps/backend/src/modules/messages/repository.ts:1008-1012` (INSERT dos campos observacionais) e é chamada pelos recorders de `process-message.ts:1129-1135` e `:1435-1439`.

Tripz usa tabela distinta: `tripz_ai_usage_logs`, inserida em `apps/backend/src/modules/tripz-ai/repository.ts:1002-1005`, com `tenant_id`, conversa/mensagem, `purpose`, modelo/provider, input/output, custo, duração e request index. A migration correspondente é `apps/backend/src/db/migrations/0114_tripz_ai.sql` (tabela Tripz).

## 5. `openrouter-credits.ts`

`apps/backend/src/modules/usage/openrouter-credits.ts:22-54` consulta a API administrativa `${OPENROUTER_BASE_URL}/credits` com `OPENROUTER_MANAGEMENT_API_KEY` (`:26-35`), rejeita HTTP não-2xx (`:38-40`), valida o payload Zod (`:42-45`) e retorna `totalCredits`, `totalUsage` e `balance = totalCredits - totalUsage` (`:47-53`). É saldo agregado da conta OpenRouter, não contabilização por tenant, conversa ou interação; não grava banco.

## 6. Outros consumidores e recomendação

- **Follow-up automático:** uma geração que pode resultar em envio ou no marcador `[[NO_FOLLOW_UP_NEEDED]]` (`ai-follow-up.ts:32`, decisão em `:233-240`). Recomendo contar a geração como interação mesmo quando decide não enviar, pois houve inferência e custo; classificar `purpose=follow_up`.
- **Figurinhas/imagens/documentos:** `analyzeMedia` (`openrouter.ts:456-575`) é uma chamada LLM independente que consome tokens/custo. Recomendo contar como interação `media_analysis` (inclusive figurinha), separada da resposta conversacional subsequente.
- **Áudio:** `transcribe` (`openrouter.ts:367-453`) é inferência independente; contar como `audio_transcription`. Se depois houver resposta, são duas operações de IA, não uma chamada duplicada.
- **Humanizador:** o arquivo `modules/messages/humanizer.ts` implementa delays, split, debounce, locks e rate limiting; não é consumidor de LLM por si só. Não contar delays/split como interação.
- **Tripz-AI:** é consumidor independente, com sua própria tabela e callback (`runtime.ts:143-146`, `repository.ts:1002-1005`). Recomendo contar cada turno lógico Tripz uma vez, com `purpose=conversation` ou `attachment`, sem misturar com o contador do atendimento.

## 7. Contagens existentes por tenant

Há contagem operacional de mensagens no painel: `apps/backend/src/app.ts:1091-1094` expõe `counts` e `messagesToday`; não é contador de IA. Há rate limit por tenant+contato em `apps/backend/src/modules/messages/process-message.ts:1396-1399`, usando `consumeRateLimitRedis` de `modules/messages/rate-limiter.ts:16-32`; limita mensagens recebidas por contato/minuto, não requests LLM. `usage_logs` e `tripz_ai_usage_logs` carregam `tenant_id` e permitem agregação, mas atualmente registram provider requests/uso, sem franquia mensal de interações.

## Recomendação final

Implementar um serviço de metering idempotente por tenant e período de cobrança, chamado uma única vez no boundary de conclusão do turno lógico. Separar `interaction_type`/`purpose` (inbound reply, follow-up, transcription, media analysis, Tripz), preservar um `request_id`/turn id único e manter `usage_logs` como granularidade de provider request para tokens, cached tokens, custo e modelo. Para o atendimento principal, não contar em `OpenRouterClient` nem em cada `onUsage`; contar após `complete` retornar e antes/de forma transacional com o envio/registro da resposta, com unique key `(tenant_id, billing_period, logical_turn_id)` para evitar duplicidade em retries.
