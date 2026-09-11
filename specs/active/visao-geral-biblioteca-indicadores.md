# SPEC: Visão Geral — biblioteca de indicadores e presets

## Objective
Estender o catálogo existente de widgets, preservar layouts salvos, disponibilizar três presets e indicadores verificáveis por tenant/período/escopo, sem usar visibilidade como filtro de dados.

## Source
Plano `.hermes/plans/2026-09-10_223826-atendon-conversas-dashboard-pipeline-instagram.md`, adendo executivo e seção B; `comments.md` bloco Visão Geral.

## Current State
Há catálogo de 11 widgets, `dashboard_layouts`, rotas de layout e componente `dashboard-widgets.tsx`. Não há presets nem métricas granulares de origem, comparecimento, no-show, reagendamento, vendas perdidas e vendedor.

## Desired Behavior
Um layout novo exibe somente os cinco widgets essenciais; layouts personalizados permanecem respeitados. O catálogo contém os grupos e 25 novas chaves do plano, presets `essencial`, `comercial`, `gestao_completa`, dados monetários em centavos e indicadores de equipe com dimensão de vendedor.

## Requirements

### R1 — Catálogo, grupos e default 80/20
Em `modules/dashboard-widgets/catalog.ts`, manter as 11 chaves e ordem atuais e acrescentar exatamente: `conversations_started`, `active_conversations`, `new_leads`, `pending_follow_ups`, `overdue_follow_ups`, `leads_paid_traffic`, `leads_referral`, `leads_organic`, `leads_other_sources`, `appointments_count`, `attendances`, `no_shows`, `reschedules`, `attendance_rate`, `sales_count`, `sales_value`, `average_ticket`, `lost_sales`, `conversion_rate`, `sales_paid_traffic`, `sales_referral`, `sales_organic`, `sales_by_seller`, `sales_value_by_seller`, `conversion_by_seller`.

Cada definição tem label pt-BR, descrição, `group`, permissões coerentes, `sizes:[small,medium]`, `defaultSize:small`. `defaultVisible:true` SOMENTE para `conversations_started`, `appointments_count`, `sales_count`, `sales_value`, `conversion_rate`; legados não permanecem default no layout novo. Indicadores de equipe preservam a dimensão e retornam `{ items: [{ member_id, name, value }], currency?: 'BRL' }`.

Acceptance Criteria:
- `dashboardLayoutFromPreset` ordena chaves do preset visíveis e o restante do catálogo oculto.
- Layout/sanitização preserva escolhas explícitas das chaves válidas e permitidas salvas, remove desconhecidas/não permitidas conforme contrato existente e nunca faz query depender de visibilidade.

Verification: teste de catálogo e `dashboard-widget-presets.integration.test.ts` conferem chaves, cinco defaults e grupos.

### R2 — Presets
Exportar `DASHBOARD_PRESET_KEYS` e `DASHBOARD_PRESETS` exatamente como o plano: `essencial` (cinco essenciais), `comercial` (conversations_started, appointments_count, attendances, sales_count, lost_sales, conversion_rate, nessa ordem) e `gestao_completa` (as 25 chaves novas listadas em R1). Em `routes.ts`, expor `GET /dashboard/widgets/presets` e `POST /dashboard/widgets/presets/:key`, atrás da mesma feature flag. Chave inválida dá `400`; POST grava layout do usuário filtrado pelas permissões, sem conceder acesso a widget indisponível.

Acceptance Criteria:
- Presets não alteram outros usuários/tenants.
- POST essencial grava exatamente cinco visíveis e mantém o restante catalogado/oculto.

Verification: integração lista três, grava essencial, rejeita chave inválida e repete a execução.

### R3 — Capacidade 0155
Criar `0155_dashboard_layout_capacity.sql`: remover constraints antigas de comprimento por definição e adicionar CHECK idempotente equivalente a array JSONB com comprimento ≤60. Atualizar validação de `order` para `.max(60)`; manter limite por `DASHBOARD_WIDGET_KEYS.length`, sem exigir 60 chaves válidas quando o catálogo for menor.

Acceptance Criteria:
- No banco, array com até 60 itens satisfaz o CHECK de comprimento; >60 falha. Na API, duplicadas/desconhecidas/não permitidas continuam rejeitadas e só itens válidos do catálogo são aceitos.
- Migration funciona em banco virgem e em instalação já migrada, sem SQL frágil que assuma nome único de constraint.

Verification: `fresh-migrations.integration.test.ts` e preset integration com prova SQL de capacidade 60/61, sem pedir à API que aceite 60 chaves inexistentes ou duplicadas.

### R4 — Dados e contratos dos indicadores
Em `loadWidgetData`, retornar `{value:number}` ou `{value:number,currency:'BRL'}`; dinheiro é NUMERIC em reais convertido para centavos inteiros no SQL antes do retorno, nunca reinterpretado como centavos. Reusar `loadCommercialDashboard` para agendamentos/equipe e nunca usar layout como filtro.

- conversas/leads: contagens e follow-ups no período/tenant.
- origem exclusiva: `paid_traffic` primeiro (`source='facebook'` ou attribution não vazia), depois `referral` (`ILIKE 'indica%'`), `organic` (`whatsapp`,`organico`), `other` complemento.
- agendamento: scheduled/completed/no_show/rescheduled e attendance rate; denominador zero retorna 0.
- vendas: fechado/perdido, valor, ticket, conversão e origens; taxas são 0–100.
- vendedor: `{items:[{member_id,name,value}], currency?:'BRL'}` usando dimensão real de `commercial.team`.

Acceptance Criteria:
- Todo indicador respeita período, tenant, permissões e escopo; ausência de dados retorna número finito.
- Ocultar widget não muda cálculo, gravação nem coleta.
- Classificação exclusiva não conta um lead em duas origens.

Verification: `dashboard-widget-metrics.integration.test.ts` testa cada chave por valor, range, tenant, escopo, dinheiro e zero denominator.

### R5 — UI
Em `dashboard-widgets.tsx`, faixa de quatro botões `Essencial`, `Comercial`, `Gestão completa`, `Personalizado`; três primeiros fazem POST e revalidam, o último abre toggles. Agrupar por `group` com títulos exatos `Atendimento`, `Origem`, `Agendamento`, `Vendas`, `Origem das vendas`, `Equipe`, derivando do catálogo. Cartão numérico reutilizável tem skeleton, erro/retry e moeda pt-BR a partir de centavos.

Acceptance Criteria:
- Preferências salvas continuam dominando defaults.
- Indicadores por vendedor não são reduzidos a número agregado.

Verification: `dashboard-presets-ui.test.tsx`, com comportamento de produção e jsdom na primeira linha.

## Invariants
- Tenant, período, permissão e escopo nunca são cruzados.
- Layout controla visibilidade, não dados.
- Cinco defaults são os únicos novos visíveis; catálogo e layouts legados continuam compatíveis.
- Valores monetários são inteiros em centavos na API; percentuais 0–100.

## Edge Cases
Divisor zero; origem em múltiplas classificações; attribution `{}`; catálogo menor que 60; layout salvo com chave antiga/nova; vendedor sem vendas; período vazio; feature flag desligada.

## Dependencies
`catalog.ts`, `dashboard-widgets/routes.ts`, `dashboard/service.ts`, migration 0099, `dashboard_layouts`, permissões e feature flag existente.

## Affected Areas
`modules/dashboard-widgets/catalog.ts`, `routes.ts`, `0155_dashboard_layout_capacity.sql`, `apps/panel/components/dashboard-widgets.tsx` e testes de dashboard.

## Non-goals
Não trocar mecanismo de layout, não criar catálogo paralelo, não reescrever queries comerciais já existentes, não afirmar 60 chaves válidas de catálogo, não alterar dinheiro/invariantes de autorização, não editar produção.

## Constraints
SQL novo idempotente e aditivo; ≤500 linhas por arquivo novo; sem dependências novas; testes reais contra banco; sem `NaN`/`Infinity`; sem stage/commit/push/deploy.

## Required Tests
`dashboard-widget-presets.integration.test.ts`; `dashboard-widget-metrics.integration.test.ts`; `dashboard-presets-ui.test.tsx`; `fresh-migrations.integration.test.ts`.

## Definition of Done
- [ ] R1–R5 cobertos por critérios e testes.
- [ ] Cada teste roda duas vezes e detecta sabotagem de `NULLIF`, filtro e visibilidade.
- [ ] Capacidade 60 não contradiz catálogo menor; dinheiro e equipe mantêm contratos.
- [ ] Revisão independente e gates finais ficam com o orquestrador.
