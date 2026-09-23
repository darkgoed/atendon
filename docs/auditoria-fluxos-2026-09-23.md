# Auditoria do sistema de fluxos/robô — 23/09/2026

## Escopo e método

Revisão do editor/lista/histórico, contratos HTTP de qualification, definição e validação do grafo, executor, integração ao processamento de mensagens, outbox, esperas, RBAC/tenancy e migrations. Auditoria funcional/defensiva; sem pentest externo, sem alteração de dados de clientes. Design preservado. Execução das alterações por GLM 5.3 Flash; orquestração/revisão por Astra.

## Causa do erro reportado

A API passou a exigir `revisao_base` em PUT/PATCH/restore. A lista não enviava o campo em criar, duplicar pelo fallback e ativar/desativar. O editor individual já usava CAS, mas a lista e seus testes ficaram fora da evolução de contrato.

Correção: criação usa 0; atualização usa revisão positiva da linha retornada pelo GET, por PATCH de `ativo`; revisão ausente/inválida impede a mutação. Conflito nunca gera replay automático. Trava síncrona evita criação duplicada antes do próximo render.

## Correções e melhoria funcional

- CAS na lista: criação, fallback de duplicação e ativação/desativação; revalidação/orientação em conflito; proteção contra clique duplo inclusive estado vazio.
- Editor: recarga explícita espera a resposta nova antes de adotar revisão/documento. Falha de recarga mantém o rascunho e proteção de saída. Resposta do save não declara salvas edições feitas depois do clique. Edição limpa feedback de sucesso anterior. Revisão inválida não vira 0. Simulação tardia de outro fluxo não altera a tela atual.
- Histórico: paginação keyset pela API existente, botão carregar mais, deduplicação e retry mantendo páginas anteriores; restore não envia token ausente/zero.
- Entrega: primeira mensagem com `outboxId` usa `QualificationService.deliverOutboxById`, o mesmo claim usado pela pump. Não há mais envio direto seguido de marcação tardia concorrendo com a fila. Sem claim/entrega confirmada não ocorre um segundo envio direto. Erro de entrega não dispara IA alternativa. Compatibilidade sem outboxId mantida.

## Matriz auditada

| Área | Evidência / decisão |
|---|---|
| PUT/PATCH/restore e concorrência | `qualification/routes.ts`: token obrigatório, leitura sob advisory lock por tenant, snapshots na mesma transação, 409 sem sobrescrever |
| Revisão no banco | migration 0182: trigger incrementa OLD.revision+1 em todo UPDATE |
| Tenant e RBAC | rotas agent.read/agent.manage, validação de referências e FKs compostas da migration 0064 |
| Grafo/nós/branches | schema e validação em flow.ts; editor e testes de roundtrip; ativação exige gatilho e alcance de final |
| Snapshot/histórico | migrations 0179/0182; versions/diff/restore; interface agora acessa páginas antigas |
| Simulação | dry-run do body, sem envio ou escrita operacional; id da URL não carrega dados de outro fluxo |
| Gatilhos e IA | robô primeiro; outcome não nulo consome turno; ausência de fluxo/gatilho mantém IA; Instagram excluído |
| Esperas/restart | estado persistido no Postgres, BullMQ + reconciliador, revalidação sob lock; restart redefine estado para o próximo inbound |
| Outbox | claim existente compartilhado com caminho imediato; persistência e chave do provedor; teste concorrente com banco real e gateway fake |
| Handoff | pausa e responsável humano preservados; nenhuma mudança de semântica de retomada/proatividade |
| Webhooks | revisão de guard de destino e timeout; nenhuma nova integração ou exploração de vulnerabilidade |
| Migrations | 0039/0040/0064/0174/0175/0179/0182 lidas; cadeia fresh-migrations em banco descartável passou; nenhuma migration nova |

## Decisões de segurança operacional

Não transformar timeout/erro ambíguo do provedor em retry cego: a mensagem pode já ter sido aceita. A política conservadora de outbox foi preservada. A hipótese de migration criar espera antiga sem sessão não se confirmou: wait_until e wait_session_id foram introduzidos juntos. Reinício proativo, replay manual de falhas, templates/import-export, mídia e novos gatilhos não foram adicionados sem contrato de produto.

## Limites explícitos

Testes de entrega usam banco real de teste e gateway simulado; não enviamos mensagens a contatos de produção. Claim com lease não equivale a garantia exactly-once perante queda após aceite do provedor. Ordenação total entre múltiplas mensagens concorrentes, reinício A→B→A do mesmo componente durante requisição e diffs de histórico concorrentes não são garantias novas desta entrega. Auditoria ampla não é certificação de inexistência de todos os defeitos.

## Verificação

Resultados finais de suites, build e publicação serão registrados no fechamento desta auditoria. Baseline do painel: 126 arquivos/689 testes aprovados. Fresh migrations: 9 testes aprovados. Testes focados do painel (lista/editor/histórico/concorrência): 54 aprovados; paginação: 2 aprovados. Entrega concorrente: 2 testes aprovados. Typecheck do candidato: backend e painel sem erros.

Evidências operacionais completas em `/home/deploy/.hermes/profiles/daybreak/cache/scratch/flow-*.log` e relatórios `flow-*.md`. Os logs não integram a release. Jev automatizado indisponível (script configurado não existe neste host); intake/decisões/revisão de escopo manuais documentados, sem alegação de gate executado.
