# comments-spec-loop — rodada Newave (comments.md do sócio)

Início: 2026-08-31 23:13 UTC
SPEC: specs/active/newave-qualificacao-e-confirmacao.md

## Fase 1-2 — leitura e investigação: CONCLUÍDA

Descobertas que mudaram o plano (todas medidas, não presumidas):

1. O prompt da Newave NÃO está no repositório. Vive em
   `agent_config_versions` no Postgres de produção
   (container `luaj67tqgrdsjlvdjrt9x3ot-postgres-1`, db `atendon`).
   - tenant `newave-ia`, agent `5b39aeee-8797-4340-ad29-52e01bf54f5f`
   - versão ativa `363e8da1-dbf8-4a0e-a1f3-75d34626f64b`, 47.991 bytes
   - runtime lê da VERSÃO ATIVA: repository.ts:491-503, ai-follow-up.ts:481,
     contextual-qualification.ts:151

2. O arquivo-fonte `instrução-newave-ia.md` foi APAGADO do git no commit
   f10934f, mas `db/newave-template.ts:4` ainda tenta lê-lo →
   `npm run provision:newave` está QUEBRADO. Restaurado de `f10934f^`.

3. O prompt do BANCO está desatualizado vs o arquivo restaurado:
   banco diz "15 minutinhos", arquivo diz "bate-papo de 20 a 40 minutos".
   `canonicalizeMeetingDurationPrompt` (process-message.ts:1894) reescreve isso
   em runtime, então não é bug ativo — mas publicar o arquivo é a correção real.

4. NÃO EXISTE lembrete de reunião ao lead. Único envio pós-agendamento é o
   link do Meet (outbox 0078). `enqueueDueAppointmentReminders` é web-push
   para o time interno, não WhatsApp para o lead.

5. `scheduling_appointments` não tinha coluna de confirmação do contato.

## Baseline medida ANTES de qualquer mudança

Banco de teste estava desatualizado (faltavam 0125/0126) → recriado antes de medir.

| Verificação | Resultado |
|---|---|
| backend `npx tsc --noEmit` | exit 0 |
| painel `npx tsc --noEmit` | exit 0 |
| painel `vitest run` | 58 arquivos, **255 testes, 0 falhas** |
| backend `npm test` | 99 arquivos, **1059 testes, 14 falhas PRÉ-EXISTENTES** |

Prova de pré-existência: `git status apps/backend apps/panel` estava VAZIO
no momento da medição.

Falhas pré-existentes: fresh-migrations (esperava 0124, repo já em 0126),
version service x3 (esperava 1.21.0, repo em 1.22.0), panel-api x3,
saas-foundation, round-robin, google-meet, tool-executor x2,
ai-follow-up-settings x2.

## Fases 3-6 — SPEC, onda de implementação e correções: CONCLUÍDAS

Partição por arquivo, 3 agentes em paralelo, sem sobreposição.

### Defeitos que EU achei nos entregáveis dos subagentes e corrigi

1. **Migration 0127 quebraria no deploy**: INSERT do feature flag omitia
   `display_name` (NOT NULL sem default). Descoberto lendo o schema real.
2. **`global_enabled=FALSE` violava a convenção do repo**: o catálogo usa NULL
   para "não lançada"; FALSE quebrou `feature-flags.integration`. Trocado por
   NULL (que continua significando DESLIGADA, pois default_enabled=false).
3. **Flag não estava no catálogo tipado** `FEATURE_FLAG_KEYS`
   (operations/feature-flags.ts) — só no banco. Regressão real minha, corrigida.
4. **`decideConfirmationMoments` nunca enfileirava o Momento 1** quando a
   reunião era em menos de 2h, e agendava o pedido de confirmação para o
   horário da reunião em vez de imediatamente. Reescrita.
5. **`interpretConfirmationResponse` transformava recusa em `sem_resposta`** —
   dispararia "última tentativa de confirmação" para quem já disse que não vai.
6. **Hesitação virava confirmação** (achado do revisor independente):
   "acho que consigo" marcava CONFIRMADO e silenciava o lembrete. Corrigido
   com lista de hesitação + teste.
7. **Painel: conflito com decisão anterior.** `comments-ui-regression.test.ts`
   proíbe o dump de respostas estruturadas no detalhe do lead (decisão de uma
   rodada anterior). Respeitadas as duas intenções: criada
   `commercialPreparationAnswers`, que expõe SOMENTE decisor e momento de
   compra. Teste de regressão atualizado documentando a exceção.
8. **Ordem de exibição** dependia do `Object.entries` do jsonb → ordem fixa.

### Migrations
- `0127_meeting_contact_confirmation.sql` — aditiva; colunas de confirmação +
  outbox + flag DESLIGADA. Sem DROP/DELETE/TRUNCATE (verificado por grep).
- `0128_newave_commercial_prompt_revision.sql` — publica o prompt como NOVA
  versão de agente (aposenta ativa → insere → reaponta), padrão provision-tripz.
  **Idempotência provada por execução real**: run 1 publica v2, run 2 é no-op.
  Estado final verificado: v1 retired, v2 active, agent_configs sincronizado.

### Testes desatualizados corrigidos (dívida herdada, não regressão desta rodada)
- `fresh-migrations`: esperava `0124` como última migration; repo já tinha 0126.
- contagem de flags 19 → 20.

## Fase 8 — Revisão independente: CONCLUÍDA

Revisor achou 4 itens. Triagem (2 procedem, 1 rejeitado, 1 já conhecido):

- **PROCEDE — `decideConfirmationMoments` ignorava `state`**: retornava
  `pos_agendamento` mesmo para quem já confirmou, recobrando confirmação de
  quem já respondeu. Corrigido + teste.
- **PROCEDE — `variant` negativo quebrava a montagem**: `-1 % 3 = -1` →
  `choices[-1]` undefined → erro ao ler `choice[0]`. Normalizado para [0,2] + teste.
- **PROCEDE (I5) — seleção de agente ambígua na 0128**: `ORDER BY updated_at
  DESC LIMIT 1` publicaria no agente errado se houvesse mais de um. Agora a
  migration ABORTA com mensagem explícita. Provado por execução real:
  com 2 agentes → `ERROR: Tenant newave-ia tem 2 agent_configs`;
  com 1 agente → `NOTICE: Revisão comercial publicada na versão 2`.
- **REJEITADO — "painel não exibe justificativa"**: a justificativa foi
  removida deliberadamente numa rodada anterior
  (`comments-ui-regression.test.ts:217-218` proíbe) e o `comments.md` não a
  pede. Reintroduzir desfaria uma decisão do usuário.

Testes de meeting-confirmation: 6 (subagente) → **11** (após minhas correções).

## Guardrail de deploy
Perfil do usuário: deploy é SEMPRE decisão dele. Nada commitado, nada deployado.

## Débito declarado honestamente
- O agendador (worker/fila) que ENFILEIRA e ENVIA as confirmações NÃO foi
  construído. O módulo tem textos + lógica de decisão testados, mas ninguém o
  importa ainda (verificado por grep). Consequência: o Momento 1 já é coberto
  pela própria resposta da IA (via prompt), mas Momentos 2 e 3 dependem desse
  agendador. A flag desligada torna isso seguro.
- `version service` x3 continua falhando (1.21.0 vs 1.22.0) — dívida anterior,
  fora do escopo desta rodada.

Atualizado em: 2026-08-31
