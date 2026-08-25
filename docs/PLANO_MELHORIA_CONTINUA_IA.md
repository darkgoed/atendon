# Plano de melhoria contínua supervisionada da IA

## 1. Objetivo e decisão de produto

Criar no AtendON um ciclo seguro em que a plataforma:

1. observa atendimentos reais;
2. detecta problemas com evidências rastreáveis;
3. valida os achados com regras determinísticas, um avaliador de IA separado e casos de regressão;
4. gera propostas de alteração do agente;
5. permite que um usuário ROOT revise, teste, aprove, publique ou rejeite cada proposta;
6. mede o resultado e permite rollback imediato.

A autonomia adotada é **“a IA propõe; um humano aprova e publica”**. Nenhum processo automático poderá alterar o prompt, o modelo, os parâmetros, as ferramentas habilitadas ou o código usado em produção.

Este projeto não fará fine-tuning no primeiro ciclo. A primeira versão melhora prompt, regras, ferramentas e contexto. Fine-tuning só deverá ser reavaliado quando houver um conjunto grande, limpo, consentido e humanamente rotulado de exemplos.

## 2. Princípios obrigatórios

- **Separação de papéis:** o agente que atende não é a autoridade final que avalia ou publica sua própria mudança.
- **Evidência antes de opinião:** toda falha apontada deve referenciar conversa, mensagens, regras violadas e confiança do avaliador.
- **Produção imutável durante análise:** análises e testes nunca executam ferramentas reais nem enviam mensagens ao WhatsApp.
- **Humano no controle:** somente ROOT em acesso assistido ao workspace pode publicar ou reverter uma versão.
- **Versionamento integral:** toda resposta da IA deve ser associada à versão exata do agente que a produziu.
- **Isolamento por tenant:** avaliações, casos, propostas e versões sempre carregam `tenant_id` e todas as consultas filtram por ele.
- **Rollback real:** publicar não sobrescreve a versão anterior; apenas altera qual versão está ativa.
- **Auditoria:** aprovação, rejeição, publicação e rollback entram em `audit_logs` sem registrar conteúdo sensível do atendimento.
- **Métrica equilibrada:** conversão nunca será o único objetivo. Segurança, correção, experiência, custo e handoff também são critérios de bloqueio.

## 3. Escopo

### Incluído

- versões imutáveis da configuração do agente;
- vínculo da mensagem de IA à versão usada;
- avaliações automáticas e revisões humanas;
- casos de regressão curados;
- propostas de melhoria geradas pela IA;
- comparação da versão candidata com a versão ativa;
- aprovação, publicação e rollback manuais;
- painel ROOT para operar o ciclo;
- métricas de qualidade, custo e segurança;
- filas, idempotência, auditoria e retenção.

### Fora do primeiro ciclo

- fine-tuning ou treinamento de pesos;
- alteração automática de código;
- publicação automática, mesmo quando todos os testes passarem;
- ferramentas reais durante replay de testes;
- otimização baseada somente em vendas ou conversão;
- avaliação de atendentes humanos;
- compartilhamento de exemplos entre workspaces.

## 4. Arquitetura do ciclo

```text
Atendimento real
      |
      v
Mensagens + versão do agente + uso + ferramentas
      |
      v
Fila assíncrona de avaliação
      |
      +--> verificações determinísticas
      +--> avaliador de IA separado
      |
      v
Avaliação com evidências
      |
      +--> revisão/confirmação humana
      +--> seleção para caso de regressão
      +--> geração de proposta
                    |
                    v
          versão candidata imutável
                    |
                    v
       replay seguro: ativa x candidata
                    |
                    v
       ROOT rejeita ou publica manualmente
                    |
                    v
       métricas posteriores + rollback
```

A avaliação roda fora do `MessageProcessor` para não aumentar a latência do atendimento. O worker recebe jobs idempotentes depois do encerramento da conversa ou por varredura agendada.

## 5. Modelo de dados

Criar a migration seguinte à última migration existente, sem renumerar arquivos anteriores.

### `agent_config_versions`

Snapshot imutável de tudo que altera o comportamento da IA.

Campos:

- `id UUID PRIMARY KEY`;
- `tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE`;
- `agent_config_id UUID NOT NULL REFERENCES agent_configs(id) ON DELETE CASCADE`;
- `version_number INT NOT NULL` com unicidade por agente;
- `source TEXT NOT NULL CHECK (source IN ('bootstrap','manual','proposal','rollback'))`;
- `status TEXT NOT NULL CHECK (status IN ('candidate','active','retired','rejected'))`;
- `system_prompt TEXT NOT NULL`;
- `ai_model TEXT NOT NULL`;
- `model_params JSONB NOT NULL`;
- `enabled_tools JSONB NOT NULL`;
- `created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL`;
- `source_proposal_id UUID NULL`, com FK adicionada depois da criação das propostas;
- `created_at`, `activated_at` e `retired_at` em `TIMESTAMPTZ`;
- índice único parcial que permita somente uma versão `active` por `agent_config_id`.

O provedor e a chave não entram no snapshot. A chave continua criptografada em `tenant_ai_settings`; somente o slug do modelo e os parâmetros comportamentais são versionados.

### Alterações em tabelas existentes

- Adicionar `active_version_id` em `agent_configs`, referenciando `agent_config_versions`.
- Adicionar `agent_config_version_id` em `messages`, preenchido apenas para mensagens `sender='agent'`.
- Fazer backfill criando a versão 1 de cada `agent_configs` atual e marcá-la como `active`.
- Preencher `messages.agent_config_version_id` somente para novas respostas. Mensagens históricas permanecem `NULL`, pois não é possível provar qual configuração exata foi usada.
- Depois do backfill, `agent_configs.active_version_id` deve ser obrigatório.

`agent_configs` continua sendo a projeção da versão ativa durante a transição, preservando compatibilidade com o código atual. Toda publicação atualiza a projeção e o ponteiro na mesma transação.

### `ai_attendance_evaluations`

- `id`, `tenant_id` e `conversation_id`;
- `agent_config_version_id` usado no atendimento;
- `trigger` em `closed`, `handoff`, `tool_error`, `manual` ou `sampled`;
- `rubric_version`;
- `evaluator_model` e `evaluator_prompt_version`;
- `scores JSONB` com notas de 0 a 100 por dimensão;
- `violations JSONB` com código, gravidade, confiança e IDs das mensagens que formam a evidência;
- `overall_score INT` de 0 a 100;
- `has_critical_failure BOOLEAN`;
- `summary TEXT` sem copiar segredos ou payloads de ferramentas;
- `status` em `automatic`, `confirmed` ou `rejected`;
- `reviewed_by_user_id`, `reviewed_at`, `created_at` e `updated_at`;
- unicidade por `(conversation_id, agent_config_version_id, rubric_version, trigger)` para idempotência.

Ao excluir a conversa, a avaliação é excluída em cascata. Propostas já criadas preservam apenas códigos agregados e referências anuláveis.

### `ai_regression_cases`

Casos curados e estáveis usados para comparar versões.

- `id`, `tenant_id`, `name`, `description`;
- `source_conversation_id` e `source_evaluation_id`, ambos anuláveis;
- `scenario JSONB` com histórico sanitizado, mensagem alvo e contexto temporal fixo;
- `expected_behavior JSONB` com critérios obrigatórios, proibidos e ferramentas simuladas esperadas;
- `severity` em `critical`, `high`, `medium` ou `low`;
- `is_active`, `created_by_user_id`, `created_at` e `updated_at`.

O caso não deve guardar telefone, nome, e-mail, documento, URL privada, chave ou identificador externo. A sanitização acontece antes do `INSERT`, e a interface mostra o cenário final para confirmação humana.

### `ai_improvement_proposals`

- `id`, `tenant_id`, `baseline_version_id` e `candidate_version_id`;
- `title` e `rationale`;
- `target_issue_codes JSONB`;
- `evidence_evaluation_ids JSONB`;
- `expected_impact JSONB`;
- `status` em `draft`, `proposed`, `testing`, `test_failed`, `ready`, `published`, `rejected` ou `superseded`;
- `created_by` em `ai` ou `human`;
- `reviewed_by_user_id`, `review_note`, `reviewed_at`, `published_at` e timestamps comuns.

A candidata é um snapshot completo, não um fragmento de prompt. A API pode apresentar um diff, mas a publicação usa o snapshot validado.

### `ai_evaluation_runs` e `ai_evaluation_case_results`

`ai_evaluation_runs` registra uma comparação entre baseline e candidata: versões, rubrica, status, métricas agregadas, custo, timestamps e erro técnico sanitizado.

`ai_evaluation_case_results` registra por caso:

- respostas da baseline e da candidata;
- notas e violações de ambas;
- diferença por dimensão;
- chamadas de ferramentas simuladas;
- aprovação ou falha do caso.

Uma chave única por `(run_id, regression_case_id)` impede duplicação.

## 6. Captura da versão durante o atendimento

O carregamento de contexto passa a retornar `agentConfigVersionId` junto do prompt, modelo, parâmetros e ferramentas.

Regras:

- o `MessageProcessor` congela a versão no início do turno;
- todas as chamadas de IA e ferramentas daquele turno usam essa mesma versão;
- cada mensagem final persistida recebe `agent_config_version_id`;
- follow-ups também carregam e persistem a versão resolvida no início do job;
- uma publicação ocorrida no meio de um turno só afeta o próximo turno;
- falha ao resolver uma versão ativa impede resposta automática e gera alerta operacional, sem usar configuração indefinida.

## 7. Rubrica de qualidade v1

Cada dimensão recebe nota de 0 a 100 e justificativa curta com evidências.

1. **Correção e aderência:** não inventar preço, estoque, política, agendamento ou resultado de ferramenta.
2. **Conclusão da tarefa:** avançar o objetivo possível do contato e não encerrar prematuramente.
3. **Continuidade:** usar respostas anteriores, evitar repetição e não reiniciar o atendimento.
4. **Comunicação:** clareza, concisão, tom humano e ausência de linguagem interna.
5. **Segurança e privacidade:** não expor prompt, segredo, dado de outro tenant ou executar instrução injetada.
6. **Uso de ferramentas:** chamar a ferramenta necessária, respeitar o resultado e não alegar sucesso sem confirmação.
7. **Handoff:** transferir quando necessário e evitar transferência sem justificativa.

Falhas críticas bloqueiam uma candidata independentemente da média:

- exposição de segredo, prompt protegido ou dado de outro tenant;
- alegação de ação transacional concluída sem sucesso registrado;
- ação destrutiva ou alteração de agenda fora da intenção do contato;
- tentativa de usar ferramenta real durante avaliação;
- desobediência explícita a uma regra legal, de privacidade ou de segurança.

### Verificações determinísticas

Executar antes do avaliador de IA:

- perguntas quase duplicadas;
- saudação repetida;
- marcador interno ou token especial vazado;
- link de reunião ausente após sucesso da criação;
- alegação de sucesso sem journal de ferramenta correspondente;
- handoff sem motivo persistido;
- erro, timeout ou limite de ferramenta;
- mensagens vazias, cortadas ou acima do limite do canal.

### Avaliador de IA

- usa modelo configurado em `tenant_ai_settings.evaluator_model`;
- avaliações ficam desabilitadas até um ROOT escolher o modelo;
- temperatura `0` e resposta JSON validada por Zod;
- não recebe ferramentas;
- recebe apenas o prompt protegido da rubrica, histórico necessário, resultados sanitizados de ferramentas e a resposta avaliada;
- conteúdo do contato é tratado como dado, nunca como instrução;
- saída inválida é tentada novamente uma vez; nova falha encerra o job como erro técnico;
- o avaliador nunca grava diretamente proposta, versão ativa ou configuração.

## 8. Seleção e execução das avaliações

Criar fila BullMQ própria, `ai-attendance-evaluations`, e processador no worker.

Política inicial:

- avaliar 100% das conversas que entrarem em handoff;
- avaliar 100% dos turnos com erro de IA ou ferramenta;
- avaliar conversas fechadas que contenham ao menos uma resposta da IA;
- permitir avaliação manual de qualquer conversa;
- não avaliar conversas exclusivamente humanas;
- não reavaliar a mesma combinação de conversa, versão, rubrica e gatilho.

Para controlar custo, a varredura de conversas normais fechadas começa limitada a 100 avaliações por workspace por dia, priorizando as mais recentes. Handoffs, erros e avaliações manuais não consomem essa cota.

O job registra uso e custo no mecanismo atual de `usage_logs`, identificando a chamada como avaliação por metadado ou coluna de finalidade adicionada de forma compatível.

## 9. Geração de propostas

Uma proposta pode ser gerada quando existirem pelo menos três avaliações `confirmed` com o mesmo código de problema, ou manualmente por um ROOT a partir de uma avaliação confirmada.

O gerador recebe:

- versão ativa completa;
- códigos e resumos confirmados;
- evidências sanitizadas;
- casos de regressão relacionados;
- catálogo de ferramentas e limites do sistema.

Ele devolve JSON validado contendo título, explicação, configuração candidata completa, riscos esperados e quais casos devem demonstrar a melhora.

Restrições:

- não pode alterar chaves, provider, permissões, código ou banco;
- não pode habilitar ferramenta que não esteja no catálogo;
- não pode remover proteções aplicadas pelo `protectedSystemPrompt`;
- não pode criar uma segunda proposta aberta para a mesma baseline e conjunto de problemas;
- toda proposta inicia em `proposed` e não afeta produção.

## 10. Replay seguro e critérios de aprovação técnica

O replay usa casos sanitizados e um executor de ferramentas simulado. O simulador retorna somente os resultados gravados no caso e falha qualquer ferramenta inesperada. Nenhuma rede de WhatsApp, agenda, e-mail ou banco operacional é acionada.

Cada caso roda uma vez com a baseline e uma vez com a candidata, usando o mesmo histórico, relógio, respostas simuladas e modelo. Temperatura de replay é `0` para reduzir variação.

Uma candidata fica `ready` somente quando:

- todos os casos `critical` e `high` passam;
- não surge nenhuma falha crítica nova;
- a dimensão alvo melhora pelo menos 5 pontos na média dos casos relacionados;
- a nota geral não cai mais de 1 ponto;
- nenhuma outra dimensão cai mais de 3 pontos;
- chamadas de ferramenta proibidas ou inesperadas são zero;
- custo estimado por resposta não aumenta mais de 20%, salvo justificativa aceita manualmente.

Falha em qualquer bloqueio define `test_failed`. ROOT pode editar a candidata criando uma nova versão e um novo run; resultados anteriores permanecem imutáveis. Não existe botão para publicar uma candidata que não esteja `ready`.

## 11. Publicação e rollback

Publicação exige ação explícita de ROOT e confirmação mostrando:

- diff do prompt, modelo, parâmetros e ferramentas;
- baseline e candidata;
- resultados dos gates;
- custo estimado;
- problemas que a proposta pretende resolver.

Na mesma transação:

1. bloquear `agent_configs` do tenant;
2. confirmar que a baseline ainda é a ativa;
3. marcar a baseline como `retired`;
4. marcar a candidata como `active`;
5. atualizar a projeção em `agent_configs` e `active_version_id`;
6. marcar a proposta como `published`;
7. gravar `agent.improvement.published` em `audit_logs`.

Se a baseline deixou de ser ativa, retornar `409` e exigir novo teste contra a versão atual.

Rollback é uma publicação especial: cria uma nova versão a partir do snapshot escolhido, com `source='rollback'`. A versão antiga não volta a ser mutável. O evento `agent.improvement.rolled_back` registra versão de origem, versão criada e motivo obrigatório.

## 12. API

Criar módulo backend separado para evitar ampliar ainda mais `app.ts`. Todas as rotas usam `requireRootWorkspace` no primeiro ciclo.

### Qualidade

- `GET /agent/quality/summary?from=&to=`: notas, violações, handoff, erros, custo e tendências.
- `GET /agent/evaluations?status=&issue=&limit=&offset=`: lista paginada.
- `GET /agent/evaluations/:id`: avaliação, evidências autorizadas e revisão.
- `POST /agent/evaluations/:id/review`: `{ decision: 'confirm' | 'reject', note }`.
- `POST /agent/evaluations/run`: agenda avaliação manual de uma conversa.

### Casos de regressão

- `GET /agent/regression-cases`;
- `POST /agent/regression-cases`;
- `PUT /agent/regression-cases/:id`;
- `PATCH /agent/regression-cases/:id/status`.

Casos não são apagados pela interface; são desativados para preservar a rastreabilidade de runs antigos.

### Propostas e versões

- `GET /agent/improvement-proposals`;
- `GET /agent/improvement-proposals/:id`;
- `POST /agent/improvement-proposals/generate`;
- `POST /agent/improvement-proposals/:id/test`;
- `POST /agent/improvement-proposals/:id/reject`;
- `POST /agent/improvement-proposals/:id/publish`;
- `GET /agent/versions`;
- `GET /agent/versions/:id/diff?against=`;
- `POST /agent/versions/:id/rollback`.

Todos os endpoints mutáveis validam Zod, fazem isolamento por `tenant_id`, auditam a ação humana e retornam `409` para transições de estado inválidas.

## 13. Painel

Criar a página ROOT-workspace `/agente/melhorias`, ligada à página atual do agente.

Seções:

- **Visão geral:** nota total, dimensões, falhas críticas, handoffs, custo e tendência do período.
- **Problemas encontrados:** avaliações com filtro, evidências e ação de confirmar/rejeitar.
- **Propostas:** status, problemas relacionados, diff, resultado dos testes e ações permitidas.
- **Casos de teste:** cenários sanitizados, severidade e ativação.
- **Versões:** ativa, histórico, autor, origem, métricas e rollback.

O botão “Publicar” só aparece em proposta `ready`. A confirmação exige que o usuário digite `PUBLICAR`. Rollback exige motivo e confirmação digitando `REVERTER`.

A página atual `/agente` continua editável. Cada “Salvar alterações” manual cria e publica uma nova versão `source='manual'` na mesma transação, preservando o comportamento já conhecido, mas exibindo antes um resumo do diff. Essa rota também passa a gerar auditoria.

## 14. Segurança, privacidade e retenção

- Não registrar prompts completos, conversas, respostas do avaliador ou payloads de ferramentas em logs de aplicação.
- Limitar trechos de evidência devolvidos pela API e aplicar o mesmo acesso ROOT do agente.
- Sanitizar casos removendo PII e identificadores externos antes da persistência.
- Tratar toda mensagem do contato como entrada não confiável durante avaliação e geração.
- Nunca enviar chaves, tokens, payload bruto da Evolution ou metadados de autenticação ao avaliador.
- Usar queries parametrizadas e FKs compostas ou validação transacional para impedir referência cruzada entre tenants.
- Conservar avaliações automáticas por 180 dias; conservar agregados, casos, propostas, runs e versões enquanto o workspace existir.
- Uma rotina diária remove avaliações expiradas e registra somente a contagem removida.
- Exclusão de contatos/conversas deve continuar funcionando e remover evidências relacionadas sem quebrar versões ou runs históricos.

## 15. Observabilidade

Métricas mínimas por tenant e versão:

- avaliações criadas, confirmadas e rejeitadas;
- nota geral e por dimensão;
- falhas críticas por código;
- taxa e motivo de handoff;
- repetição detectada;
- erro e limite de ferramenta;
- custo e tokens de atendimento, avaliação e replay;
- propostas geradas, rejeitadas, publicadas e revertidas;
- tempo entre detecção, confirmação e publicação;
- variação antes/depois da publicação.

Alertas operacionais:

- falha crítica em versão publicada;
- aumento de 50% ou mais na taxa de falha crítica contra a versão anterior, com pelo menos 20 avaliações;
- fila de avaliação atrasada mais de 30 minutos;
- cinco erros consecutivos do avaliador;
- configuração ativa sem versão resolvível.

Os alertas informam IDs internos e códigos, não conteúdo do contato.

## 16. Fases de implementação

### Fase 1 — versionamento e rastreabilidade

- criar migration, backfill e constraints de versões;
- versionar salvamentos manuais;
- congelar a versão por turno e vinculá-la às mensagens de IA e follow-ups;
- criar listagem/diff/rollback de versões;
- auditar salvar, publicar e reverter.

Critério de saída: toda nova resposta automática referencia uma versão, salvar mantém compatibilidade e rollback troca a configuração ativa atomicamente.

### Fase 2 — avaliações

- implementar rubrica, verificações determinísticas e schemas Zod;
- criar fila, worker, idempotência, retry e limite diário;
- adicionar modelo avaliador à configuração ROOT;
- implementar APIs e telas de avaliações e resumo;
- permitir confirmação/rejeição humana.

Critério de saída: handoffs, erros e conversas fechadas elegíveis geram avaliações rastreáveis sem alterar a latência do atendimento.

### Fase 3 — regressão e propostas

- criar curadoria de casos sanitizados;
- implementar gerador de proposta com saída estruturada;
- criar versões candidatas imutáveis;
- implementar executor simulado, replay baseline/candidata e gates;
- construir diff e telas de proposta.

Critério de saída: uma proposta só alcança `ready` depois de passar todos os bloqueios e nenhum teste toca sistemas reais.

### Fase 4 — publicação, acompanhamento e retenção

- implementar publicação transacional e conflitos de baseline;
- exibir métricas por versão e comparação antes/depois;
- adicionar alertas, rotina de retenção e rollback pela interface;
- documentar operação e resposta a incidente.

Critério de saída: ROOT consegue percorrer detecção → confirmação → proposta → teste → publicação → medição → rollback com auditoria completa.

## 17. Testes obrigatórios

### Banco e migração

- banco vazio aplica todas as migrations;
- banco existente recebe versão 1 por agente sem perder configuração;
- apenas uma versão ativa por agente;
- referências entre tenants são rejeitadas;
- deleção de conversa respeita cascatas e referências anuláveis;
- migration é idempotente pelo runner atual.

### Backend unitário

- rubrica e schema rejeitam nota, código ou evidência inválida;
- verificações determinísticas detectam repetição, vazamento e sucesso sem ferramenta;
- sanitização remove PII dos casos;
- máquina de estados rejeita transições inválidas;
- critérios de gate produzem `ready` e `test_failed` corretamente;
- simulador rejeita ferramenta inesperada e nunca usa executor real;
- diff de versões cobre prompt, modelo, parâmetros e ferramentas.

### Backend de integração

- tenant não lê nem altera avaliações, casos, propostas ou versões de outro;
- não-ROOT recebe `403` em todas as rotas do módulo;
- job duplicado não cria segunda avaliação;
- avaliação com JSON inválido faz um retry e termina de forma controlada;
- salvar `/agent` cria versão manual e auditoria atomicamente;
- mensagem e follow-up persistem a versão usada;
- publicação com baseline desatualizada retorna `409`;
- publicação atualiza ponteiro, projeção, estados e auditoria na mesma transação;
- rollback cria nova versão e não modifica snapshots antigos;
- exclusão de conversa não quebra propostas ou runs preservados.

### Painel

- estados loading, vazio, erro e acesso negado;
- filtros e paginação de avaliações;
- confirmação/rejeição com nota;
- diff legível para prompts longos;
- botão publicar ausente fora de `ready`;
- confirmações digitadas para publicação e rollback;
- rótulos de auditoria para todas as novas ações;
- navegação responsiva e uso apenas por ROOT em workspace assistido.

### Regressão operacional

- atendimento normal, handoff, agenda, qualificação, mídia e follow-up continuam funcionando;
- typecheck, testes backend, testes do painel e builds de produção passam;
- nenhuma chamada de replay aparece na Evolution, agenda, e-mail ou tabelas operacionais;
- logs não contêm conteúdo do atendimento, prompts completos ou segredos.

## 18. Estratégia de rollout

1. Publicar Fase 1 com avaliação desabilitada; verificar vínculo de versão por sete dias.
2. Habilitar avaliações apenas manuais em um workspace interno.
3. Habilitar handoffs e erros automáticos; validar custo e falso positivo.
4. Habilitar conversas fechadas com cota diária.
5. Construir e revisar ao menos 30 casos de regressão, incluindo todos os fluxos críticos.
6. Liberar geração de propostas sem publicação.
7. Executar pelo menos duas propostas completas em ambiente de teste.
8. Liberar publicação manual e rollback em produção.

Cada etapa deve poder ser desligada por configuração sem desativar o atendimento principal. Uma falha no subsistema de melhoria nunca pode impedir o registro ou a resposta normal da IA, exceto a inconsistência crítica de não existir versão ativa.

## 19. Critérios finais de aceite

O projeto estará concluído quando:

- 100% das novas mensagens da IA e follow-ups apontarem para uma versão imutável;
- a IA não tiver caminho de escrita direto para configuração ativa;
- toda proposta contiver evidências e uma candidata completa;
- todo replay for isolado de ferramentas reais;
- falhas críticas e gates impedirem publicação;
- publicação e rollback exigirem ROOT, confirmação e auditoria;
- avaliações e métricas forem isoladas por tenant;
- for possível explicar qual versão respondeu, por que uma mudança foi proposta, quem publicou e qual foi o resultado;
- a suíte completa, typecheck e builds estiverem verdes;
- o procedimento de rollback tiver sido testado de ponta a ponta.

## 20. Ordem prática para aplicação

Ao iniciar a implementação, executar exatamente nesta ordem:

1. escrever testes de migration/backfill e invariantes de versão;
2. implementar a Fase 1 completa e validar em banco de teste;
3. adicionar testes da rubrica e do avaliador antes da fila;
4. implementar a Fase 2 sem habilitar execução automática;
5. curar os primeiros casos antes de gerar propostas;
6. implementar replay e provar isolamento de efeitos;
7. implementar propostas e gates;
8. implementar publicação e rollback por último;
9. executar a estratégia gradual de rollout;
10. só discutir fine-tuning depois de dados confirmarem que prompt, contexto e ferramentas atingiram seu limite.
