# Profiling AtendON — Relatório de otimizações (2026-10-01)

Complementa `docs/PROFILING_BASELINE_2026-10-01.md` (evidências coletadas antes de
qualquer alteração). Toda otimização abaixo foi validada com medição antes/depois
na mesma instância (API local `tsx` em :3999 apontando para o Postgres/Redis locais,
`NODE_ENV=production`) e testes do backend.

## Otimização A — Cache TTL de feature flags/capabilities

**Evidência antes:** cada checagem recarregava TODAS as definições + dependências
(2 queries). ~13,5 queries de flag por widget; **63.638 cargas em 10 dias** (a
query mais chamada do banco). Toda rota com gate (`enforceRequestCapability`,
dashboard, qualification, scheduling…) pagava esse custo por request.

**Mudança** (`modules/operations/feature-flags.ts`): cache por tenant, TTL 3s,
single-flight (promessa compartilhada), evicção em erro. Ativo **somente em
produção** (testes mutam flags via SQL direto) e **somente para leituras via
pool** — leituras dentro de transação (PoolClient) continuam ao vivo. Mesmo
padrão do cache de unread-counts já existente em `app.ts`.

**Antes → depois (rajada de 24 widgets × 3):**

| métrica | antes | depois (A) |
| --- | --- | --- |
| queries de flags por rajada | 486 (~7/widget) | **0** |
| p50 por widget | 531–719ms | **283ms** |
| p95 por widget | 818–1030ms | **663ms** |
| wall por rajada | 0,60–1,24s | **0,30–0,76s** |

## Otimização B — Single-flight para `loadCommercialDashboard`

**Evidência antes:** ~15 dos 24 widgets executam o agregado comercial completo
(9 queries) na mesma rajada — o mesmo agregado era recalculado ~15×
simultaneamente, saturando o pool (max 10) e serializando as respostas.

**Mudança** (`modules/dashboard/service.ts`): single-flight + TTL 3s por
(tenant, usuário, período). Produção apenas, mesmo racional da A: testes criam
dados e consultam na mesma janela; realtime revalida o painel.

**Antes → depois (acumulativo, mesma rajada):**

| métrica | depois (A) | depois (A+B) | depois (A+B+C, sem ruído) |
| --- | --- | --- | --- |
| p50 por widget | 283ms | **226ms** | **210ms** |
| p95 por widget | 663ms | **546ms** | **578ms** |
| max por widget | 721ms | **566ms** | **587ms** |
| wall por rajada | 0,30–0,76s | 0,25–0,65s | **0,28–0,64s** |

`/dashboard` (endpoint único): p50 **113ms** (antes: 820ms nos logs de produção).

## Otimização C — Guard no polling de `web_push_outbox`

**Evidência antes:** a reconciliação roda a cada 15s e, em repouso, os 2 UPDATEs
de manutenção (supressão + reclaim) devolviam **0 linhas** em 5.235 execuções
cada, custando 4–5ms/tick cada (roundtrip + COMMIT — medido: no-op UPDATE =
6–20ms). ~47s de DB em 10 dias para não fazer nada, por processo worker, para
sempre — padrão que degrada com o crescimento da tabela/tenants.

**Mudança** (`modules/web-push/repository.ts`): um `SELECT EXISTS` barato
(sem escrita, sem COMMIT) decide se os UPDATEs precisam rodar; no repouso o
tick paga ~0,1ms em vez de ~10ms. Semântica preservada (os UPDATEs rodam sempre
que houver candidatos). Testes: web-push 14/14 ✓.

## Verificação

- `tsc --noEmit`: limpo (1 erro pré-existente em `tests/billing-efipay-mandates.integration.test.ts`, no HEAD).
- Suíte completa: 2440 ✓ / 8 ✗. Das falhas: `changelog-reads` e
  `inbound-lead-resolution` falham **sem** minhas mudanças (verificado via stash),
  `billing-efipay-mandate-routes` está quebrado no HEAD (erro de TS), e
  `saas-foundation` já consta no baseline de falhas do repo. As 2 restantes
  (`billing charge wiring`, `organization-migration`) passam isoladas — eram
  timeouts por carga durante a suíte. Módulos tocados: dashboard (24 ✓),
  feature-flags/capability-gates (28 ✓), web-push (14 ✓).

## Pendências com evidência (próximos passos, não aplicados)

1. **Auth por request = 3–4 queries** (`users`, `workspace_sessions`, `tenants`,
   repetidas pelo gate) — multiplicador em rajada; qualquer cache aqui mexe em
   invariantes de revogação de sessão, requer design próprio.
2. **Rajada de ~20 HTTP requests do painel** por carregada do dashboard: um
   endpoint batch colapsaria auth+flags+dados numa chamada (mudança de API+front).
3. **Chunk do ECharts (1,1MB, 377KB gzip)**: já é `next/dynamic` + `ssr:false`
   (`components/ui/chart.tsx`), baixa só quando há gráfico — sem ação.
4. **SSE já multiplexado** (1 conexão compartilhada por tenant) e
   **unread-counts já com cache de 3s** no servidor.
5. Event loop ocioso (99,8% no profile), memória saudável (API 108MiB /
   worker 129MiB), cache hit do Postgres 99,97%, sem deadlocks. Sem gargalo
   detectado em jobs/IA no tráfego atual (worker 0,37% CPU).
6. Listas de conversas/mensagens: paginação por cursor com limite ≤100 — sem
   necessidade de virtualização no volume atual (775 conversas).
