# Operação da melhoria contínua supervisionada da IA

Este procedimento cobre habilitação gradual, revisão, publicação, resposta a incidente e rollback do ciclo descrito em `PLANO_MELHORIA_CONTINUA_IA.md`.

## Controles de rollout

Os controles ficam em **Agente → Melhoria da IA → Visão geral** e são isolados por workspace:

- **Modelo de avaliação:** habilita somente avaliações manuais quando preenchido.
- **Avaliações automáticas:** adiciona handoffs, erros de ferramenta e conversas fechadas. Conversas fechadas têm cota de 100 avaliações por workspace/dia.
- **Geração de propostas:** permite criar candidatas, ainda sem acesso à produção.
- **Publicação manual:** libera o último passo, sempre condicionado a proposta `ready`, ROOT em acesso assistido e confirmação digitada.

Desligar qualquer controle não desativa o atendimento principal. A exceção é uma configuração ativa sem versão resolvível: nesse caso a resposta automática é bloqueada e um alerta operacional é criado.

## Sequência de habilitação

1. Após aplicar as migrations, mantenha os três controles desligados e confirme por sete dias que novas mensagens de agente e follow-ups possuem `agent_config_version_id`.
2. Escolha o modelo avaliador em um workspace interno. Execute apenas avaliações manuais.
3. Ative avaliações automáticas e acompanhe custo, fila, falsos positivos e revisões humanas.
4. Cure pelo menos 30 casos sanitizados, cobrindo atendimento normal, handoff, agenda, qualificação, mídia e follow-up.
5. Ative geração de propostas. Gere e teste ao menos duas propostas sem habilitar publicação.
6. Valide que os runs não produziram efeitos em Evolution, agenda, e-mail ou tabelas operacionais.
7. Ative publicação manual. Faça uma publicação controlada e execute o rollback de ponta a ponta.

## Revisão de uma avaliação

1. Abra **Problemas** e filtre por `automatic`.
2. Leia o resumo, os códigos e os trechos autorizados de evidência.
3. Confirme somente quando a evidência sustentar o problema; caso contrário, rejeite.
4. Registre nota curta e objetiva. A nota e a decisão entram na auditoria, sem prompt completo ou payload de ferramenta.
5. Uma avaliação já revisada não pode ser revisada novamente.

## Proposta e replay

1. Gere uma proposta a partir de avaliação confirmada ou de três avaliações confirmadas com o mesmo código.
2. Confira o snapshot completo da candidata e o diff de prompt, modelo, parâmetros e ferramentas.
3. Execute o replay. O worker usa relógio fixo, temperatura zero e `SimulatedToolExecutor`; ferramenta inesperada falha o caso.
4. A proposta só fica `ready` quando todos os gates passarem. Não existe publicação para `test_failed`.
5. Rejeite propostas obsoletas ou inadequadas para preservar uma trilha explícita.

## Publicação controlada

Antes de publicar, confirme:

- proposta em `ready`;
- baseline ainda ativa;
- todos os casos críticos e altos aprovados;
- nenhuma falha crítica nova;
- melhora alvo mínima de 5 pontos;
- regressão geral máxima de 1 ponto e por dimensão de 3 pontos;
- zero ferramenta proibida ou inesperada;
- aumento de custo de até 20%, ou justificativa aceita;
- controle **Publicação manual** habilitado.

Na interface, digite `PUBLICAR`. A transação aposenta a baseline, ativa a candidata, atualiza a projeção, conclui a proposta e grava `agent.improvement.published`.

Um `409` indica baseline desatualizada ou transição inválida. Não force a publicação; teste uma nova candidata contra a versão atual.

## Resposta a incidente e rollback

Sinais de incidente incluem falha crítica na versão ativa, aumento de 50% na taxa crítica após 20 avaliações, fila atrasada por mais de 30 minutos e cinco erros consecutivos do avaliador.

1. Desative **Publicação manual** e **Geração de propostas** no workspace afetado.
2. Se o avaliador estiver instável, desative **Avaliações automáticas**. O atendimento continua ativo.
3. Em **Versões**, compare a ativa com a última versão estável.
4. Escolha **Rollback**, registre o motivo e digite `REVERTER`.
5. Confirme que uma nova versão com `source='rollback'` ficou ativa. O snapshot antigo não deve ter sido alterado.
6. Verifique `audit_logs` para `agent.improvement.rolled_back`, incluindo versão de origem, versão anterior e motivo.
7. Envie uma conversa de teste e confirme que a nova mensagem aponta para a versão de rollback.
8. Mantenha os controles de rollout desligados até concluir a análise da causa.

## Verificações pós-incidente

```sql
SELECT id,version_number,source,status,activated_at,retired_at
FROM agent_config_versions
WHERE tenant_id = '<tenant-id>'
ORDER BY version_number DESC;

SELECT id,sender,agent_config_version_id,created_at
FROM messages
WHERE conversation_id = '<conversation-id>'
ORDER BY created_at DESC;

SELECT action,resource_id,metadata,created_at
FROM audit_logs
WHERE workspace_id = '<tenant-id>'
  AND action IN ('agent.improvement.published','agent.improvement.rolled_back')
ORDER BY created_at DESC;
```

Não copie prompts, conversas ou payloads de ferramentas para tickets ou logs. Use IDs internos, códigos de violação, métricas agregadas e timestamps.
