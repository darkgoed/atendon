# Profiling AtendON — Rodada 2: consolidação do dashboard (2026-10-01)

Continuação de `PROFILING_BASELINE_2026-10-01.md` e `PROFILING_RELATORIO_2026-10-01.md`.
Objetivo: eliminar o custo estrutural restante do carregamento do dashboard sem
enfraquecer segurança, consistência realtime ou isolamento multi-tenant.

## 1. Arquitetura ANTES

```
Painel (abre dashboard)
 └─ 23 requests simultâneas  GET /dashboard/widgets/:key
     └─ por request: jwtVerify + users(1q) + workspace_sessions(1q) + tenants/members(1q)
        + requireWorkspace REPETIDO no gate (mesmas queries de novo)
        + feature flags: 2 queries POR checagem (≈13/request)
        + widget "sales/leads": loadCommercialDashboard completo (9 queries) por widget
        └─ pool pg max=10 saturado pela rajada (p50 531–719ms, p99 753ms em prod)
```

## 2. Arquitetura DEPOIS

```
Painel (abre dashboard)
 └─ 1 request  GET /dashboard?include=widgets&period=…
     ├─ auth/workspace/permissões resolvidos 1× por request (memo WeakMap request-scoped)
     ├─ flags/capabilities: cache por tenant c/ invalidação pós-COMMIT (TTL = fallback)
     ├─ agregados compartilhados calculados 1×:
     │    loadCommercialDashboard (single-flight+TTL) + 5 grupos de métricas (1 query/grupo)
     │    + counts + handoffs + connection + pipeline + alerts (só os que o catálogo pede)
     ├─ widgets DERIVADOS dos agregados (payload idêntico aos endpoints individuais)
     └─ realtime: 1 sinal → invalida cache comercial do tenant (deliverSignal)
                 → painel revalida a 1 request consolidada (single-flight contra stampede)
Endpoints individuais /dashboard/widgets/:key preservados (rollback/uso pontual).
```

## 3. Bugs encontrados nos caches anteriores (FASE 0)

1. **Staleness realtime (confirmado por teste):** mutação → sinal → SWR revalida →
   backend devolve agregado ainda em cache (TTL 3s) → se nenhum outro evento chegar,
   o painel fica preso no valor antigo. Reproduzido em
   `tests/dashboard-cache-consistency.integration.test.ts`.
2. **Flags sem invalidação de escrita:** rotas admin alteravam flags e o cache só
   expirava por TTL.
3. **Chave do cache comercial incompleta:** não incluía role/isRoot (mudança de
   escopo podia reusar agregado do escopo antigo dentro do TTL).
4. **Crescimento desaboundado:** chaves com `start`/`end` custom criavam entrada
   por intervalo de datas, sem limite.
5. **Timezone:** trocar o fuso do workspace não invalidava o agregado (períodos
   calculados no fuso antigo até o TTL).

## 4. Invalidações adicionadas

- `invalidateCommercialDashboardCache(tenantId)` chamada em
  `RealtimeCoordinator.deliverSignal` para `conversation.messages.changed`,
  `appointment.changed`, `case.assignment.changed`, `alerts.changed` (ponto de
  recepção do sinal → cobre mutações de qualquer processo, via NOTIFY/Redis).
- `invalidateEffectiveFlagsCache(tenantId?)` pós-COMMIT nas 6 rotas admin de
  escrita de flags (`operations/routes.ts`); global/kill switch limpam todos os
  tenants; override por tenant limpa só o tenant (teste prova que B permanece).
- `invalidateCommercialDashboardCache` no `PATCH /workspaces/current/timezone`.
- TTL (3s) permanece como fallback; promessas rejeitadas são evictadas nos dois caches.

## 5. Queries removidas por request (FASE 1)

Medição `pg_stat_statements` (rajada de 50 requests com gate, antes/depois via stash):

| query | antes | depois | eliminadas/request |
| --- | --- | --- | --- |
| users (identidade) | 102 | 51 | 1 |
| workspace_sessions (revogação) | 102 | 51 | 1 |
| workspace_members+roles+permissions | 102 | 51 | 1 |

≈ **3 queries eliminadas por request com gate** (memoização por request via
WeakMap; revogação e mudança de acesso continuam valendo na request seguinte —
testado em `tests/auth-request-scope.integration.test.ts`).

## 6–7. Requests HTTP e SQL (mesma carga de host, A/B com stash)

Host com load 15–19 (processos externos de outra sessão) nas duas medições —
comparação relativa válida; absolutas são limites superiores.

| cenário (5 carregadas do dashboard) | BASELINE | NOVO | Δ |
| --- | --- | --- | --- |
| HTTP requests por carregada | 23 | **1** | −96% |
| SQL total por carregada (rajada individual) | ~280 | ~72 | −74% |
| SQL por carregada via bundle | — | **~6** (warm) | −97% vs baseline |
| cargas de flags por rajada (115 req) | 696 | 4 | −99% |
| queries de auth por rajada | 232/232/231 | 120/117/116 | −50% (2×→1×) |

## 8–9. Benchmark COLD e WARM (mesmas condições, A/B)

| métrica | baseline cold | novo cold | baseline warm | novo warm |
| --- | --- | --- | --- | --- |
| p50 | 675ms | **485ms** | 360ms | **59ms** |
| p95 | 1300ms | 886ms | 426ms | 138ms |
| max | 1300ms | 886ms | 426ms | 138ms |
| erros | 0 | 0 | 0 | 0 |

(COLD = TTL do agregado expirado; WARM = dentro da janela. Rajada antiga no novo
código: p50 292ms/p95 637ms — cai de 1296/2336ms no baseline, −77%.)

## 10. Benchmark concorrente (novo código, host load ~19)

| fase | p50 | p95 | max | erros |
| --- | --- | --- | --- | --- |
| 1 usuário | 621ms | 683ms | — | 0 |
| 5 usuários | 503ms | 655ms | 655ms | 0 |
| 20 usuários | 960ms | 1814ms | 1900ms | 0 |
| 5 dashboards / 3 tenants | 576ms | 921ms | 921ms | 0 |
| 20 dashboards / 3 tenants | 665ms | 1722ms | 1751ms | 0 |

## 11. Impacto no pool PostgreSQL

`pg_stat_activity` durante rajada de 23: 0–4 queries ativas, ≤12 conexões do
processo (pool max=10 + listener). Sem saturação, sem lock waits, sem timeouts,
sem explosão de promises (single-flight segura rajadas no agregado e nos flags).
Pool NÃO foi aumentado — o trabalho redundante foi que foi removido.

## 12. Testes adicionados/atualizados

Novos (backend): `dashboard-cache-consistency` (4 — staleness realtime, chave
tenant/usuário/papel/período, eviction de promise rejeitada, cap FIFO),
`feature-flag-cache` (2 — invalidação pós-COMMIT global e por tenant),
`dashboard-bundle` (3 — equivalência widget-a-widget com endpoints individuais,
contrato preservado sem `include`, isolamento por tenant),
`auth-request-scope` (3 — revogação por session_version, revogação de
workspace_session, erro de auth não memoizado).
Painel: `dashboard-reference-overview` e `dashboard-single-overview` atualizados
ao contrato consolidado (4 testes ✓, incluindo "1 request só" e "período reconsulta o bundle").

## 13. Regressões encontradas durante a rodada

- Meu teste de flags poluiu o banco de teste (restaurou `global_enabled=false`
  onde o original era NULL) e quebrou um teste pré-existente — corrigido no
  restore do teste e no banco. 
- Bug de unwrap no `widgetOf` do painel (payload undefined) — capturado pelos
  testes do painel antes de qualquer deploy; corrigido.
- Suítes afetadas no final: **99/99 ✓** (dashboard, flags, capability-gates,
  web-push, realtime, session-repository, auth-request-scope); typecheck backend
  e painel limpos (1 erro pré-existente em teste de billing no HEAD); lint dos
  arquivos tocados limpo.

## 14. Problemas não resolvidos (com razão)

- Auth ainda custa 3–4 queries/request **de propósito**: frescor de revogação é
  invariante de segurança; cache entre requests está fora de escopo (restrição da fase).
- Endpoints individuais mantidos (contrato/rollback) — continuam custando mais
  que o bundle por design; o painel não os usa no carregamento.
- Números absolutos desta rodada foram medidos com o host sob load 15–19
  (loop de testes de outra sessão); as comparações A/B são internamente válidas
  (mesmas condições), as absolutas são limites superiores.

## 15. Conclusão — próximo gargalo (por números)

Com o bundle quente, o carregamento do dashboard é **1 request, ~6 queries,
p50 59ms**; frio, ~485ms dominados pelo re-cálculo do agregado comercial
(10 queries), já em single-flight. O Node ficou ocioso (event loop ~99,8% na
medição anterior), o pool não satura com 20 usuários simultâneos, não há erros
nem timeout. O custo restante por request é majoritariamente autenticação
(jwtVerify + 3 queries de frescor de sessão) e rede/proxy — reduzir isso exige
 abrir mão de revogação imediata (decisão de segurança, não de performance).
**Não há evidência para continuar otimizando esta superfície; otimizar mais
aqui seria dívida, não melhoria.**
