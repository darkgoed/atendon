# OPS-04 — entrega operacional orientada a eventos

## Caminhos primários

- Handoff: a notificação é persistida junto da pausa da conversa e enfileirada
  somente depois do commit.
- Follow-up: a agenda persistida é enfileirada com `delay` e identidade formada
  por conversa, versão da sequência e instante de execução. Cada conclusão
  agenda o próximo evento depois do commit.
- Avaliação: com `evaluation_event_enqueue_v2` ligado, handoff, fechamento e
  sinais de erro criam `ai_evaluation_events` na mesma transação da origem.
  O evento permanece `pending` até o avaliador concluir seu efeito idempotente.
- Com `evaluation_event_enqueue_v2` desligado, a seleção automática legacy
  continua ativa. Tenants com a flag ligada são excluídos dessa varredura.

Uma falha entre commit e enqueue não desfaz o estado durável. Os reconciliadores
keyset recuperam o item posteriormente e os IDs determinísticos do BullMQ
deduplicam enqueues concorrentes.

## Reconciliação de recuperação

| Fluxo | Intervalo | Página | Limite por execução |
| --- | ---: | ---: | ---: |
| Handoff | 120 s | 100 | 1.000 |
| Follow-up | 60 s | 100 | 1.000 |
| Avaliação | 120 s | 100 | 1.000 |

As métricas root-only expõem, por fluxo e sem tenant ou PII:
`examined`, `enqueued`, `deduplicated`, `error` e `oldest_age_ms`.

## Circuit breaker do avaliador

O estado é mantido no Redis, portanto sobrevive ao restart do worker:

- janela de falhas: 15 minutos;
- abertura: 5 falhas;
- cooldown aberto: 5 minutos;
- uma conclusão bem-sucedida remove os estados de falha e abertura.

Os nomes das chaves são `atendon:evaluator:circuit:<tenant UUID>:failures` e
`atendon:evaluator:circuit:<tenant UUID>:open`. O UUID nunca é usado como label
de métrica ou retornado pelo endpoint operacional.

## Aplicação

1. Aplicar `0081_operational_event_delivery.sql`.
2. Publicar API e worker com a flag ainda desligada.
3. Validar readiness, filas, outboxes e métricas root-only.
4. Habilitar `evaluation_event_enqueue_v2` apenas pela rotina controlada de
   feature flags, começando por tenant de validação.
5. Confirmar que eventos passam de `pending` para `completed` e que a varredura
   legacy não seleciona o tenant habilitado.

Checksum congelado da migration 0081:
`43a494c6be75043aba169d5e2b65512250079cefbdaac1589552b98ea0fda255`.
