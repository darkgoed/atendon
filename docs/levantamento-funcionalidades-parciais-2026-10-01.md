# Levantamento de funcionalidades parcialmente implementadas — AtendON (2026-10-01)

Escopo: `apps/backend`, `apps/panel`, `apps/proposal-renderer`, `db/migrations`, specs e docker-compose do worktree `apps/atendon` (branch `feat/atendon-multi-whatsapp`, incluindo mudanças em andamento). Método: varredura de marcadores (TODO/FIXME/placeholder/mock/stub/"em breve"/feature flag), cruzamento estrutural das 456 rotas HTTP do backend contra todos os call sites do painel (`api`/`fetch`/`useSWR`), varredura de 159 tabelas de migrations vs. referências no código, varredura de botões sem handler, flags/env órfãs e consulta à intenção em specs (`specs/active/*.md`), docs e `comments.md`. Cada item abaixo traz evidência e classificação: **abandonada**, **incompleta**, **dívida técnica** ou **deliberadamente reservada**. TODOs não foram tratados como problema por si só (os três únicos marcadores reais do backend são `TODO(wave-c)`, listados como dívida).

## A. Funcionalidade abandonada

### A1. Ciclo de "melhoria contínua da IA" (avaliação/replay de agente)
- **Evidência**: migrations `0051_ai_improvement_cycle.sql` e `0054_ai_evaluation_failure_signals.sql` criam `ai_evaluation_runs`, `ai_attendance_evaluations`, `ai_improvement_proposals`, `ai_regression_cases`, `ai_evaluation_case_results`, `ai_evaluation_signals`; nenhuma delas tem referência em `apps/backend/src` (só `ai_attendance_evaluations` sobrevive como leitura agregada em `modules/operations/operational-snapshot.ts:154`). `docs/HANDOFF_PAUSA_PLANO_BANCO_IA_2026-07-26.md` e `docs/PLANO_MELHORIA_CONTINUA_IA.md` documentam a pausa; a migration destrutiva de limpeza foi represada (ver D2).
- **Resquícios no produto**:
  - Botão **"Avaliar com IA"** no menu de ações da conversa (`apps/panel/app/conversas/page.tsx:1688` antes da correção) chamava `POST /agent/evaluations/run`, rota que **não existe** no backend — erro garantido para todo usuário ROOT que clicasse. Prometia "O resultado aparecerá em Melhoria da IA", página que não existe mais.
  - Helper morto `runConversationEvaluation` (`apps/panel/lib/conversations-api.ts:21`).
  - Flag `AI_EVALUATOR_ENABLED` definida em `src/config.ts:167` e repassada pelo `docker-compose.yml:38`, mas **lida por ninguém** (o changelog 1.0.12 backfill em `0160_release_pipeline_backfill.sql:30` descreve o avaliador removido).
  - Labels de auditoria `agent.improvement.*` e `ai_improvement_proposal` em `apps/panel/lib/labels.ts:88-92,125` (mantidos: traduzem eventos históricos de audit_logs).
- **Classificação**: abandonada (o backend do ciclo foi retirado; a intenção atual é remover o resto — a migration 0126 staged confirma).

## B. Funcionalidade incompleta (backend pronto e testado; interface ausente)

Padrão dominante: a ONDA 2 da spec mestre `specs/active/v7-port-crm-whatsapp.md` entregou e mantém testes de integração do backend, mas parte da UI exigida pela própria spec nunca foi construída. Todas as suítes backend citadas passam (auditoria 2026-09-24 e reexecução desta rodada).

1. **Reports (B1 da v7)** — `GET /reports/conversation-volume|agent-productivity|status-flow|quality` + `/reports/export/csv` (`modules/reports/routes.ts:44-77`), testes em `tests/reports.integration.test.ts`; não existe página `/relatorios` no painel (nenhum consumidor). A spec define a UI (5 abas + filtros + export CSV/PDF).
2. **2FA TOTP + sessões ativas (B2 da v7)** — backend completo: `POST /me/totp/setup|activate|deactivate`, `POST /auth/totp/verify` (2º passo do login), `GET /me/sessions`, `DELETE /me/sessions/:id`, `POST /me/sessions/revoke-others` (`src/auth/security-routes.ts`), desafio no login (`src/app.ts:586-592`, `src/auth/session.ts:62-64`), testes `tests/totp-sessions.integration.test.ts` (11/11 na reexecução). O painel não tinha UI nem tratamento do `{totp_required:true}` do login. **→ Implementado nesta rodada (ver E).**
3. **Merge de contatos (B5 da v7 / R11 da v6)** — `POST /organization/leads/merge/preflight` e `/organization/leads/merge` (`modules/organization/lead-merge-routes.ts:34-41`), migration `0181_lead_merge.sql`, testes `tests/lead-merge.integration.test.ts`; painel sem dialog de merge ("mesclar" não existe na UI).
4. **Gestão de equipes (B2/B3 da v7)** — CRUD completo `GET/POST/PATCH/DELETE /organization/teams` (`modules/organization/teams-routes.ts:46-68`), migrations `0176/0177`; o painel só lê `GET /organization/teams` para mapeamento de rotas do Google Calendar (`components/google-calendar-settings.tsx:66`). Sem UI de criar/editar/atribuir equipes; testes `tests/teams.integration.test.ts`.
5. **Fluxos: analytics/executions e templates (C1.d/f da v7)** — `GET /qualification/flows/:id/analytics` e `/executions` (`modules/qualification/routes.ts:472,510`) e CRUD `/qualification/flow-templates` (:405-463) sem consumidor no painel (o editor de fluxos consome versions/diff/restore, mas não analytics nem templates).
6. **Nova conversa** — `POST /conversations/initiate` (`modules/messaging/routes.ts:38`), testes `tests/messaging-initiate.integration.test.ts`; a "nova-conversa dialog" exigida pela spec não existe no painel ("nova conversa" sem resultado na UI).
7. **Capabilities de mensageria (C1.h da v7)** — `GET /me/messaging-capabilities` (`modules/messaging/routes.ts:21`) sem consumidor; o gating do nó `interactive` no editor de fluxos depende dele.
8. **Galeria de mídia do armazenamento** — `GET/DELETE /organization/storage/media` (`modules/organization/storage.ts:684-689`) sem UI (a config de retenção existe em configurações; `tests/storage-media-gallery.integration.test.ts` cobre o backend).
9. **Alertas: "marcar todas como lidas"** — `PATCH /alerts/read-all` (`src/app.ts:930`) testado (`tests/panel-api.integration.test.ts:464-468`) sem botão na página /alertas. **→ Implementado nesta rodada (ver E).**
10. **Menores** — `GET /panel/versions` (`modules/release/routes.ts:186`, lista releases publicadas por tenant) sem consumidor (o painel usa `/panel/version` singular e `/root/versions`); `GET /usage/credits` e `GET /usage/export` (`src/app.ts:1151-1171`, ROOT) sem UI na página /uso.

## C. Dívida técnica

1. `TODO(wave-c)` em `modules/tripz-ai/document/brand-settings.ts:28` (pool privado do repository), `editorial.ts:4` (tipar via domain) e `editorial.ts:486` (remover `castTripzProposalState` quando `domain.ts` exportar `TripzProposalStateV2`) — intenção clara, aguardando aterrissagem de tipos.
2. `GET/PATCH /workspaces/current` (`src/app.ts:744-745`) sem consumidor direto (o painel usa só os sub-recursos: `/workspaces/current/timezone`, `/members`, `/audit-logs`) — sobrou da era pré-`/me`.
3. `GET /qualification/sessions` (`modules/qualification/routes.ts:131`) lista `whatsapp_sessions` sem consumidor — sobreposto pelos endpoints de conexões (`/connections`, multi-WhatsApp).
4. `GET /conversations/pending-actions` (`src/app.ts:1687`) sem consumidor — superfície de "fila de próximas ações" que não avançou (relacionada ao tema da spec `conversas-filas-responsavel-proxima-acao`).
5. `docker-compose.yml:24` **exige** `TENANT_API_KEY` (`:?Configure`) que nenhum código lê — resquício de `tenant_api_keys` (criada em `0006`, sem referência em src; a staged 0126 a remove).
6. Teste de regressão pinava o botão morto "Avaliar com IA" (`tests/comments-ui-regression.test.ts:69`) — atualizado nesta rodada.

## D. Código deliberadamente reservado (NÃO implementar sem decisão de produto)

1. **Gateways de pagamento**: `billing/providers/stripe.ts` e `pagbank.ts` são stubs registrados de propósito ("§14/§15 … provar que a arquitetura aceita um provider"); a UI admin mostra "Em breve" para não-Mercado Pago (`apps/panel/app/root/saas/gateways/page.tsx:34`). A spec `saas-consumo-ia-e-gateways.md:551` orderna: "Stripe/InfinitePay/PagBank aparecem como 'Em breve' (§81); sem OAuth nem API deles."
2. **Migration destrutiva represada** `db/migrations-pending-approval/0126_remove_retired_ai_and_api_key_data.sql.staged` — remove as tabelas do item A1 + `tenant_api_keys`; o mecanismo (`README.md` do diretório) é deliberado: a runner executa tudo em `db/migrations/`, então a limpeza aguarda aprovação explícita com backup. **Nota**: a staged esquece `ai_evaluation_signals` (0054), que também está órfã.
3. **`POST /connection/reconnect` + `GET /connection`** (`src/app.ts:1080-1088`) — API da era single-conexão, ainda exercida por testes (`tests/multi-whatsapp-connections.integration.test.ts:490`); o painel usa `/connections/:id/reconnect`.
4. **Placeholders do proposal-renderer** (`src/fixtures/references.ts`) — assets de teste do renderer, não produto.
5. **`NotImplementedError`** (`src/billing/providers/types.ts:33`) — parte do contrato `BillingProvider` para métodos opcionais.
6. **Feature flags vivas** — `conversations_delta_v2`, `ai_turn_visibility_v1`, `alerts_delivery_v2`, `dashboard_v1`, `appointments_v1`, `leads_v1`, `pipeline_v1`, `dashboard_widgets_v1` são servidas por `/feature-flags` (`modules/operations/`) e consumidas no painel; com kill-switch e overrides gerenciáveis por rotas ROOT. Nenhuma flag morta além de `AI_EVALUATOR_ENABLED` (item A1).

## E. Implementado nesta rodada (intenção inequívoca e coerente com o produto)

1. **Remoção do resquício "Avaliar com IA"** (A1): botão, handler `queueManualEvaluation`, estados, notice, imports (`Flask`, `canAccessRootWorkspace`) em `app/conversas/page.tsx`; helper `runConversationEvaluation` em `lib/conversations-api.ts`; expectativa do teste de regressão invertida (`not.toContain`).
2. **"Marcar todas como lidas" em /alertas** (B9): botão no header quando `unread > 0`, chamando o `PATCH /alerts/read-all` já testado (`app/alertas/alertas-content.tsx`).
3. **2FA TOTP + sessões ativas no painel** (B2): novo `components/account-security.tsx` (ativar com QR via `qrcode.react` já dependência do painel + chave manual + código; desativar com senha; lista de sessões com revogação individual — encerrar a própria desloga — e "encerrar outras"; padrão DS v2), integrado em `app/perfil/page.tsx`; `GET /me` agora expõe `totpEnabled` (`src/auth/workspace-service.ts`); tela de login trata `{totp_required:true}` e adiciona o 2º passo via `POST /auth/totp/verify` com os mesmos redirecionamentos (`app/login/page.tsx`).
4. **Testes**: novos `tests/account-security.test.tsx` (5), `tests/login-totp.test.tsx` (4), `tests/alerts-mark-all.test.tsx` (3); atualização de `tests/comments-ui-regression.test.ts`.
5. **Gates executados**: `tsc --noEmit` limpo no painel e no backend; `eslint` limpo nos arquivos tocados; vitest do painel verde (22 testes nas suítes novas/atualizadas + 21 nos testes que pinam o código de /conversas); backend em banco descartável: `totp-sessions` 11/11 e `panel-api` 35/35 (inclui read-all e /me).

## F. Falsos positivos relevantes (verificados e descartados)

- `TODO` case-insensitive em PT-BR ("todos", "aplicar a todos") — não são marcadores.
- `placeholder` de inputs, mocks `vi.mock` e fixtures de teste — uso legítimo.
- Rotas "órfãs" construídas dinamicamente: `registerConfigCrud` gera `/scheduling/config/{unidades,categorias,parceiros}` (`routes.ts:1204-1211`); URLs de widget (`/dashboard/widgets/<chave>`), `/instagram/media/:id` (URL assinada devolvida nos payloads), `/events` (SSE em `lib/realtime.ts:27`), `/trash`, `/root/billing/*` (consumidas por `app/root/saas/{billing,metricas}`) são consumidas.
- Funções exportadas "sem referência" — a heurística produziu 192 candidatos, todos verificados por amostragem como usados no próprio arquivo, em `scripts/` ou por testes; nenhum módulo inteiro morto encontrado.

## G. Recomendações (exigem decisão de produto, não implementadas)

1. Aprovar/ajustar a staged 0126 (incluindo `ai_evaluation_signals` na limpeza) e, em seguida, remover `AI_EVALUATOR_ENABLED` (config + compose) e o requisito `TENANT_API_KEY`.
2. Priorizar UI pendente da v7 ONDA 2 em ordem de valor: merge de contatos (risco operacional de duplicidade), reports, gestão de equipes, dialog de nova conversa, analytics/templates de fluxos, galeria de mídia.
3. Definir destino de `GET /panel/versions`, `/usage/export` e `/conversations/pending-actions` (construir UI, documentar como API interna ou remover).
