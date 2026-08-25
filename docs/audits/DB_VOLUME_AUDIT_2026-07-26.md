# Auditoria volumétrica DB-01/02/03/04 — 2026-07-26

Status: **aprovada**

Comando reproduzível:

```bash
rtk npm run audit:database-volume -w @atendon/backend
```

O auditor cria um banco PostgreSQL com nome UUID, aplica todas as migrations,
executa a carga e os ensaios, e remove o banco no bloco `finally`. Nenhum
identificador do banco, tenant, usuário, conversa, lead, alerta ou mensagem é
incluído neste relatório.

## Dataset sintético

| Entidade | Volume |
|---|---:|
| Tenants | 2 |
| Mensagens | 50.000 |
| Mensagens por timestamp empatado | 25.000 |
| Alertas | 10.000 |
| Recibos de alerta | 10.000 |
| Compromissos | 16.001 |

O baseline foi capturado no mesmo banco e com cache previamente aquecido,
desabilitando localmente `indexscan`, `indexonlyscan` e `bitmapscan`. Nenhum
índice foi removido e nenhum schema foi alterado. Os números são de uma execução
de aceitação, não representam p95 de produção.

## Resultados dos planos

Todos os planos indexados ficaram sem sort amplo e sem seq scan amplo nas
relações críticas. DB-01 reproduz o `UNION ALL` que inclui a mensagem atual, mas
pré-limita as mensagens persistidas antes dessa união e das janelas.

| Item | Índice usado | Linhas retornadas | Buffers baseline → índice | Tempo ms baseline → índice |
|---|---|---:|---:|---:|
| DB-01 histórico recente | `idx_messages_conversation_recent` | 100 | 715 → 104 | 12,197 → 0,738 |
| DB-04 cursor inicial | `idx_messages_conversation_recent` | 101 | 715 → 5 | 7,511 → 0,076 |
| DB-04 cursor anterior | `idx_messages_conversation_recent` | 101 | 715 → 5 | 9,137 → 0,384 |
| DB-02 compromisso ativo | `idx_appointments_one_active_per_lead` | 1 | 327 → 3 | 2,118 → 0,073 |
| DB-02 capacidade | `idx_appointments_active_availability` | 419 | 327 → 97 | 4,141 → 2,695 |
| DB-03 recibos por usuário/alerta | `idx_alert_receipts_user_alert` | 100 | 104 → 5 | 1,914 → 0,102 |
| DB-03 listagem atual | `system_alerts_tenant_created_idx` + PK de recibos | 50 | 247 → 157 | 7,889 → 0,309 |

## Invariantes funcionais

- A paginação keyset percorreu as 25.000 mensagens de uma conversa sem perda ou
  duplicação, inclusive com timestamps empatados.
- Consultas parametrizadas para mensagens, recibos e compromissos não retornaram
  dados do outro tenant.
- Duas transações concorrentes tentaram criar um compromisso ativo para o mesmo
  lead: exatamente uma confirmou e a outra recebeu `23505`.
- O auditor falha se o planner deixar de usar um índice esperado, introduzir
  sort amplo, introduzir seq scan amplo, quebrar isolamento, perder/duplicar
  cursor ou aceitar dois compromissos ativos.

## Correção validada

O primeiro ensaio reproduziu uma falha de DB-01: limitar somente depois de
combinar mensagens persistidas com a linha retornada por `msg` impedia o índice
e visitava 50.000 linhas.

A consulta corrigida materializa primeiro as 100 mensagens persistidas mais
recentes, une a linha atual e então reaplica limite/janelas sobre no máximo 101
linhas. O teste funcional com mais de 500 mensagens preservou cronologia estável,
mensagem atual, filtro de sticker e orçamento de caracteres. Nenhuma migration
foi alterada.

## Limites

- A comparação usa dados sintéticos e cache local aquecido.
- Tempos absolutos variam entre máquinas; buffers, índices escolhidos e
  invariantes são os critérios primários.
- O ensaio não substitui métricas p95/p99 e planos capturados em produção.
