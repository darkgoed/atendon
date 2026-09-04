# Revisão adversarial SaaS — Fase 8

## Veredito
**REPROVADO — há defeitos de alto impacto no controle de quota/idempotência.** Não alterei código de produção, não fiz commit nem deploy.

## Achados

### ALTO — pré-checagem de quota de IA não é serializada
**Path:line:** `apps/backend/src/modules/messages/process-message.ts:2494-2505`; `apps/backend/src/billing/ai-metering.ts:19-29`.

`canConsumeAiInteraction()` lê limite e uso em consultas separadas, fora de uma transação e sem lock. Duas mensagens simultâneas podem observar o mesmo `used < limit`, ambas gerar/enviar resposta e somente depois registrar o consumo. O `recordAiInteractionForTenant()` ocorre em transação posterior e não impede a decisão já tomada. O cliente pode receber respostas além da franquia e o tenant pode ter custo de IA acima do contratado.

**Correção proposta:** fazer a decisão e a reserva/incremento idempotente dentro da mesma transação; bloquear a linha de `usage_counters`/assinatura com `FOR UPDATE`, ou usar operação atômica `UPDATE ... WHERE used + delta <= limit RETURNING`. O envio deve ocorrer apenas após a reserva, com compensação explícita se o envio falhar.

**Prova:** o fluxo contém literalmente `canConsume...` antes de `sendReply()` e `record...` depois (`process-message.ts:2496-2505`); portanto não existe exclusão mútua entre a leitura e a contabilização. Não foi possível executar teste concorrente real sem banco de teste/configuração válida.

### ALTO — idempotência do turno de IA depende de UUID aleatório
**Path:line:** `apps/backend/src/modules/messages/process-message.ts:967`; `apps/backend/src/modules/messages/process-message.ts:2503`; `apps/backend/src/billing/ai-metering.ts:11-16`.

Quando não fornecido, `requestId` é `randomUUID()`. Esse valor é usado como `logicalTurnId` para `buildAiTurnIdempotencyKey()`. Assim, reprocessar o mesmo inbound/job com nova invocação normalmente gera uma chave SHA-256 diferente e insere outro `usage_event`. O reprocessamento pode contar duas vezes, violando a garantia de contagem idempotente e cobrando/limitando incorretamente o cliente.

**Correção proposta:** derivar a chave de um identificador persistente do turno/mensagem (`tenantId + purpose + messageId` ou external inbound ID), não do request ID; manter request ID apenas para tracing. Adicionar teste que processe o mesmo inbound duas vezes com request IDs distintos e exija um único evento.

### MÉDIO — override de limite pode conceder limite `null` sem distinguir intenção
**Path:line:** `apps/backend/src/billing/entitlements.ts:41-45`; `apps/backend/src/billing/limits.ts:12-14`.

Um override de limite com `intValue: null` é aceito pelo schema da rota e convertido em `null`, que significa ilimitado tanto em entitlements quanto na checagem de limite. Isso pode ser intencional para ROOT, mas não há validação de que a chave seja uma permissão de limite ilimitado nem trilha de autorização adicional. Um override inválido para qualquer limit catalogado desliga a fiscalização comercial daquele limite para o tenant.

**Correção proposta:** permitir `null` somente para chaves explicitamente ilimitadas/catalogadas, validar limites contra `limit_catalog`, e representar “remover override” separadamente de “ilimitado”.

### BAIXO — hint de credencial expõe os quatro últimos caracteres
**Path:line:** `apps/backend/src/billing/providers/credentials.ts:2`.

`credentialsHint()` retorna `••••${value.slice(-4)}`. Não reconstrói sozinho uma credencial forte, mas reduz o espaço de busca e pode permitir confirmação/correlação quando o atacante conhece candidatos (tokens curtos, cartões mascarados ou credenciais reutilizadas). Deve ser tratado como dado sensível; não encontrei uso exposto nas rotas SaaS revisadas.

**Correção proposta:** não retornar sufixo de segredos; usar apenas “configurada” ou um identificador não reversível/rotacionável.

## Verificações explícitas

- **Autorização em `modules/saas/routes.ts`:** verificado por leitura rota a rota. Todas as rotas `/root/saas/*` chamam `requireRoot(r)` antes das consultas/escritas, inclusive PATCH de plano e DELETE de override. Não encontrei rota `/root/saas/*` sem essa chamada. `/billing/my-plan` usa `requireWorkspace(r)` e exclusivamente `session.tenantId`; não lê tenantId de query/body/header/param.
- **Fail-open sem assinatura:** verificado em `entitlements.ts:18-24`: cria e preenche `features` com `true` somente para features não futuras e `limits` com `null`; não retorna objeto vazio.
- **SUSPENDED:** verificado em `entitlements.ts:38,44`: feature comercial fica falsa; feature `category === "core"` permanece disponível quando habilitada no plano/override.
- **Override expirado:** verificado em `entitlements.ts:30`: somente overrides `expires_at IS NULL OR expires_at > now()` são carregados.
- **`is_future` via override:** verificado em `entitlements.ts:43-44`: override só é aplicado quando `meta && !meta.is_future`; não concede feature futura.
- **Lock de limites:** verificado em `limits.ts:6-8`: `SELECT ... FOR UPDATE` é a primeira operação da função e usa o `PoolClient` recebido. Isso serializa chamadas que realmente usam essa função no mesmo transaction client, mas não corrige o caminho de IA acima, que não chama `assertLimitWithinTransaction`.
- **Incremento após conflito:** verificado em `usage.ts:3`: o contador só é atualizado quando `inserted.rowCount > 0`; conflito não incrementa.
- **Credenciais nas rotas SaaS:** as respostas de `routes.ts` não incluem consultas/retornos de `credentials_encrypted` ou `webhook_secret_encrypted`. A revisão estática não encontrou retorno de credencial em claro nessa camada.
- **Falha de contabilização:** verificado em `process-message.ts:2502-2506`: falha de `recordAiInteractionForTenant` é capturada e logada, não derruba o processamento após a resposta.
- **Mensagem quando quota acaba:** verificado em `process-message.ts:2496-2500`: marca inbound como processado e retorna `fallback`, sem lançar exceção nessa ramificação. Não consegui confirmar, sem executar o sistema, se o chamador sempre traduz `fallback` para uma resposta/transferência humana adequada.

## Não verificado

- Não executei teste concorrente real de Postgres: o ambiente de teste/database necessário não foi disponibilizado nesta revisão.
- Não consegui provar por execução o comportamento completo de handoff humano no caminho de quota esgotada; apenas o ramo local (`markInboundProcessed` + `return "fallback"`) foi confirmado.
- A allowlist de `enforceRequestEntitlement` foi comparada apenas estaticamente com registros visíveis em `app.ts`; não foi possível enumerar em runtime todas as rotas Fastify após plugins. A allowlist isenta `/root`, `/auth`, `/health`, `/ready`, `/me`, `/workspaces/current`, `/events`, `/webhooks` e `/billing/my-plan`; não há mapeamento de `/conversations` ou `/leads` nela, mas o gate só bloqueia os padrões listados em `featureForRoute`.
- Não verifiquei por execução contratos de erro 409 existentes; `app.ts` contém o payload legado `error/code/feature/fallback`, mas a implementação completa do error handler e consumidores externos requer teste HTTP.
- Não auditei todos os logs de todos os módulos/provedores fora da camada SaaS; não encontrei segredo explícito nos arquivos pesquisados, mas isso não prova ausência global.
