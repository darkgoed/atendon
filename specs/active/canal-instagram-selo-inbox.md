# SPEC: Canal — WhatsApp e Instagram no inbox

## Objective
Modelar o canal na conexão, expô-lo nas APIs e mostrar selo WhatsApp/Instagram no inbox, deixando ingestão real do Instagram explicitamente fora desta fase.

## Source
Plano `.hermes/plans/2026-09-10_223826-atendon-conversas-dashboard-pipeline-instagram.md`, adendo executivo e seção D; `comments.md` bloco Instagram.

## Current State
`whatsapp_sessions` não possui `channel`; Evolution cria sempre `WHATSAPP-BAILEYS`; conversations têm `session_id` NOT NULL e podem herdar canal por join. Não há credenciais Meta nem ingestão Instagram configurada. `GET /connections` usa `listByTenant` em `modules/whatsapp/session-repository.ts`, e o tipo de painel está em `apps/panel/lib/connections.ts`.

## Desired Behavior
Toda conexão legada é `whatsapp`; o canal aparece em connections e conversations; criação Instagram é recusada claramente com 501 até a fase 2; o inbox mostra selo acessível ao lado do contato e no cabeçalho da thread.

## Requirements

### R1 — Migration 0157
Criar `0157_connection_channel.sql` com `whatsapp_sessions.channel TEXT NOT NULL DEFAULT 'whatsapp'`, CHECK exclusivo `whatsapp|instagram`, índice parcial por tenant/canal para conexões não arquivadas, `IF NOT EXISTS`/drop-recreate seguro do CHECK e comentário de que Instagram só está modelado nesta fase. Não adicionar coluna redundante em conversations nem fazer backfill de milhões de linhas.

Acceptance Criteria:
- Linha antiga lê `whatsapp`; valor inválido não grava.
- Tenant e FK existentes permanecem intactos; migration roda em banco virgem e instalação já existente.

Verification: `fresh-migrations.integration.test.ts` e teste de constraint/legado.

### R2 — API de conexões
Em `modules/whatsapp/routes.ts`, `GET /connections` seleciona/devolve `channel` usando `session-repository.ts:listByTenant`; `ConnectionState` em `apps/panel/lib/connections.ts` inclui união literal. `POST /connections` aceita `channel: z.enum(['whatsapp','instagram']).default('whatsapp')`; para Instagram responde exatamente `501 {code:'CHANNEL_NOT_AVAILABLE'}` com mensagem “Canal Instagram ainda não disponível para conexão”, sem criar instância ou simular ingestão.

Acceptance Criteria:
- Toda leitura filtra tenant e respeita autorização existente.
- WhatsApp mantém comportamento/integration atual; Instagram é uma recusa explícita.

Verification: `connection-channel.integration.test.ts` testa linha legada, criação Instagram e isolamento.

### R3 — API de conversas
No `GET /conversations`, incluir `session.channel AS channel` via join de `whatsapp_sessions session` por `id=c.session_id AND tenant_id=c.tenant_id`, preservando filtros e escopo já existentes. D2 é responsabilidade integrada ao dono de A4/A5, não deve ser duplicado pelo módulo de canal.

Acceptance Criteria:
- Canal retornado corresponde à conexão da conversa.
- Join não cria vazamento cross-tenant nem remove conversas sem resultado inesperado; `session_id` continua obrigatório.

Verification: `connection-channel.integration.test.ts` e teste de listagem com conexões dos dois canais.

### R4 — Selo no painel
Criar `apps/panel/components/channel-badge.tsx`:
`ChannelBadge({channel:'whatsapp'|'instagram', size?:number})`; usar `WhatsappLogo`/`InstagramLogo` de `@phosphor-icons/react`, tamanho default 12, `aria-label`/`title` “Canal WhatsApp” ou “Canal Instagram”, `currentColor`, sem dependência nova. Consumir em `conversas/page.tsx` no item da lista e cabeçalho da thread, junto ao nome.

Acceptance Criteria:
- Ambos os canais renderizam ícone/label correto e não introduzem cor/tokens novos.
- O componente não aceita valor fora da união; ausência de canal não quebra dados legados (normalização na fronteira para whatsapp).

Verification: `conversation-queues-ui.test.tsx` verifica os dois canais por renderização real e acessibilidade.

## Invariants
- Uma única fonte de verdade: canal pertence a `whatsapp_sessions`.
- Conversa herda canal por `session_id`; nenhum canal falso é inventado.
- Isolamento tenant, autorização e filtros de conversas permanecem.
- Instagram schema-ready não significa ingestão disponível.

## Edge Cases
Conexão legada; channel nulo/impossível em fixture; conexão arquivada; conversa sem sessão (não deveria ocorrer); pedido Instagram repetido; tenant tentando consultar conexão alheia; canal desconhecido retornado por dado corrompido.

## Dependencies
Migration 0152/schema de sessions e conversations, `session-repository.ts`, `modules/whatsapp/routes.ts`, `apps/panel/lib/connections.ts`, página de conversas e Phosphor já instalado.

## Affected Areas
`0157_connection_channel.sql`, `modules/whatsapp/routes.ts`, `modules/whatsapp/session-repository.ts`, `apps/panel/lib/connections.ts`, `apps/panel/components/channel-badge.tsx`, `apps/panel/app/conversas/page.tsx` e testes.

## Non-goals
Não criar credenciais Meta, não integrar Evolution/Instagram Messaging, não criar instância Instagram, não alterar produção, não duplicar `channel` em conversations, não mudar layout/token visual além do selo.

## Constraints
Arquivo novo <500 linhas; migration aditiva/idempotente; não alterar APIs de terceiros; testes backend via `npm run test:disposable`, painel com jsdom na primeira linha; sem stage/commit/push/deploy.

## Required Tests
`connection-channel.integration.test.ts`; `conversation-queues-ui.test.tsx`; `fresh-migrations.integration.test.ts`; testes de listagem de conversations e repository quando necessários.

## Definition of Done
- [ ] R1–R4 e códigos/labels exatos verificados.
- [ ] Linha legada devolve WhatsApp; Instagram devolve 501 sem efeito colateral.
- [ ] Selo funciona nos dois pontos do inbox sem regressão visual/tenant.
- [ ] Cada teste roda duas vezes e nenhuma ingestão simulada é aceita.
- [ ] Revisão independente e gates finais ficam com o orquestrador.
