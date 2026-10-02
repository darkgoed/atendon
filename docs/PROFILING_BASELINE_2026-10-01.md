# Profiling AtendON — Baseline (2026-10-01)

Profiling orientado por evidência, coletado da stack de produção rodando neste host
(Coolify `luaj67tqgrdsjlvdjrt9x3ot`), sem alteração de código. Escopo: AtendON apenas.

## Ambiente

- API: Fastify 5, Node 22, pool pg `max=10` (`apps/backend/src/db/client.ts`).
- Worker: BullMQ (Redis), mesmo pool config.
- Painel: Next.js (standalone), SWR para dados.
- DB: PostgreSQL 16, `pg_stat_statements` ativo; Redis 7; Evolution API v2.3.7.
- Janela de coleta: ~10 dias de `pg_stat_statements` (stats desde o deploy), 24h de logs pino.

## Baseline dinâmica (antes de qualquer otimização)

### PostgreSQL (pg_stat_statements, top por tempo total)

| achado | evidência |
| --- | --- |
| **Feature flags recarregadas por query** | `SELECT d.flag_key,d.description,...` — **63.638 chamadas**, 15,0s total, 0,24ms médio; + `SELECT capability_key,required_capability_key FROM capability_dependencies` — **63.638 chamadas** (2 queries por checagem de flag/capability). Fonte: `resolveCapability` → `listEffectiveCapabilities` carrega TODAS as definições + dependências + overrides a cada chamada (`modules/operations/feature-flags.ts`). |
| **Polling web_push_outbox sem trabalho** | 2 UPDATEs de claim com **0 rows retornadas**: 5.235 chamadas × 4,97ms + 5.235 × 4,15ms ≈ **47s de DB** só para não enviar nada. |
| Tabelas pequenas | `messages` 48 rows/14MB; `conversations` 775 rows; maior tabela 15MB — volume ainda baixo. |
| Saúde | cache hit 99,97%, 0 deadlocks, 4 conexões idle. |

### API (logs pino, 24h, 1.285 requests)

- p50 2ms / p90 55ms / p99 753ms / max 855ms.
- **Todas as 80 requests >300ms são do dashboard**: `/dashboard` + ~24× `/dashboard/widgets/*`.
- As lentas ocorrem **em rajada** (todas completam na mesma janela de <1s, ao abrir a página).
- CPU dos containers ~0% no repouso; API 108MiB, worker 129MiB — sem pressão de memória.

### Reprodução da rajada (instância local da API, mesmo DB, `--cpu-prof`)

- Request individual autenticado: ~15–35ms (widget) — SQL real <1ms.
- Rajada de 24 widgets (como o painel faz com 20 hooks SWR): wall 0,6–0,8s (prod), 1,4–3,5s (local tsx) com degradação entre rajadas.
- **CPU profile: processo 99,8% idle** → a latência é espera de I/O, não CPU do Node.
- Contenção cresce com concorrência: widget n=1 33ms → n=24 334ms (serialização no pool pg/roundtrips).

### Custo por request autenticado (caminho atual)

1. `requireSession`: jwtVerify + `users` (1 q) + `workspace_sessions` (1 q).
2. `requireWorkspace`: `tenants` ou members+permissions (1–2 q).
3. Gate de capability (`enforceRequestCapability`): `requireWorkspace` de novo + 2 q de flags.
4. Rota dashboard: `featureEnabled` (2 q) + `ensureWidgetAccess` (2 q + catálogo ≈ 5 capabilities × 2 q) + dados.
- Widget "sales/leads": chama `loadCommercialDashboard` completo (9 queries) **por widget**; ~15 dos 24 widgets o chamam → ~135 queries só de agregados + ~400 queries de flags/auth por carregada do dashboard.
- Painel revalida os ~20 widgets a cada sinal realtime (`conversation.messages.changed`, `appointment.changed`, `case.assignment.changed`) quando a aba está visível.

### Painel (bundle)

- `.next/static` = 4,7MB; chunk único **6983.\*.js = 1,1MB** (a identificar); framework 192K.

## Gargalos priorizados (evidência → impacto)

1. **Flags/capabilities recarregadas por checagem** (~480 queries de flags por carregada do dashboard; 63k chamadas em 10 dias) — custo por request em toda rota com gate; piora com concorrência (pool 10). → cache por tenant com TTL curto + invalidação nas escritas.
2. **`loadCommercialDashboard` re-executado por widget na mesma rajada** (~15× 9 queries simultâneas) → single-flight/short-TTL cache por (tenant, escopo, período).
3. **Auth por request = 3–4 queries** (`users`, `workspace_sessions`, `tenants`) — multiplicador em rajada; sensível a segurança (revogação), tratar com cuidado.
4. **web_push_outbox claim UPDATE 0-rows** (47s DB/10d) — padrão de polling; índice parcial ou claim via PK.
5. **Chunk 1,1MB do painel** — verificar conteúdo (provável lib pesada) e code-split.

## Protocolo antes/depois

- Benchmark de rajada reprodutível (script contra :3110/:3999): wall time + p50/p95/p99 por widget.
- `pg_stat_statements` delta por otimização (chamadas das queries de flags deve despencar).
- Testes do backend (`npm run typecheck` + suite) após cada mudança.
