# Plano integrado — banco eficiente, privado e IA verificável

## 1. Objetivo

Este plano trata os dois sentidos possíveis de “o banco não ser leito”:

1. impedir que o PostgreSQL fique **lento** conforme crescem mensagens, alertas, usuários e agendamentos;
2. impedir que banco, logs ou provedores de IA sejam **lidos indevidamente**, reduzindo privilégios e dados enviados;
3. impedir que a IA invente fatos transacionais, principalmente data, horário, duração, status e link de reunião.

O resultado desejado é um fluxo em que:

- PostgreSQL permanece a fonte de verdade;
- Redis transporta eventos e mantém apenas caches versionados, nunca a verdade da agenda;
- toda afirmação transacional da IA possui evidência persistida;
- respostas críticas são compostas deterministicamente no backend;
- nenhuma versão de prompt, modelo, parâmetros ou ferramentas chega à produção sem regressão;
- mudanças são ativadas por tenant, observadas e reversíveis sem `down migration`.

## 2. Decisões de arquitetura

### 2.1 Banco

- Não fazer ajuste especulativo de memória do PostgreSQL agora. A base observada tem cerca de 16 MB, 972 mensagens, 38 conversas, cache hit de aproximadamente 99,98%, sem deadlocks ou arquivos temporários.
- Corrigir primeiro consultas, polling, transações longas, índices e observabilidade. Ajustar `shared_buffers`, `work_mem` ou `max_connections` somente depois de métricas representativas.
- Manter migrations existentes imutáveis. Toda mudança de schema entra na próxima migration disponível.
- O runner atual executa cada migration em transação. Portanto, `CREATE INDEX CONCURRENTLY` exige um modo explícito sem transação ou um passo operacional separado. Para a base pequena atual, um índice comum em janela controlada é aceitável.

### 2.2 IA

- O modelo pode redigir linguagem, mas não pode criar fatos de agenda ou alegar sucesso.
- Data, hora, duração, status, unidade e link são renderizados a partir do resultado tipado da ferramenta.
- Sem journal concluído e consistente, a resposta deve informar incerteza ou falha; nunca sucesso.
- RAG/`pgvector`, se adotado, serve apenas para documentos e FAQ com citação. Não serve para agenda, lead, disponibilidade ou resultado de ferramenta.
- Reduzir temperatura e contexto apenas após replay e canário; não alterar diretamente a configuração ativa.

### 2.3 Privacidade e isolamento

- Minimizar e sanitizar dados antes de enviá-los ao avaliador ou outro provedor, e não apenas antes de persistir a resposta.
- Separar papel de migration do papel de runtime. O usuário de aplicação não deve ser superusuário, criar roles, criar bancos ou replicar.
- Avaliar RLS como defesa adicional, começando por um piloto. Em pool, RLS exige contexto de tenant definido e limpo em toda transação; ativá-la globalmente sem essa disciplina é risco de indisponibilidade.

## 3. Linha de base e riscos confirmados

| Prioridade | Evidência atual | Risco |
|---|---|---|
| P0 | `createAppointment()` chama Google OAuth/Meet dentro de uma transação com locks | conexões e locks presos por latência externa |
| P0 | prompt menciona reunião de 15 minutos; unidade ativa usa `slot_duration_min=60` | IA informa uma duração e agenda outra |
| P0 | confirmação atual garante principalmente o link, mas deixa outros fatos no texto livre | data, hora, duração ou status inventados |
| P0 | publicação manual/template pode ativar versão sem o mesmo gate da proposta | regressão de prompt/modelo diretamente em produção |
| P0 | avaliador recebe conteúdo bruto antes da sanitização, sem teto global do payload | exposição desnecessária de PII ao provedor |
| P0 | papel PostgreSQL de runtime possui privilégios administrativos; nenhuma tabela usa RLS | impacto elevado em caso de falha de aplicação |
| P1 | histórico aplica janelas sobre toda a conversa antes de limitar 100 mensagens/24 mil caracteres | custo crescente por turno e follow-up |
| P1 | alertas fazem polling a cada 5 s; leitura cria/atualiza recibos e calcula contagem | amplificação de leituras e escritas |
| P1 | thread de conversa faz polling a cada 5 s e retorna até 500 mensagens mais antigas | payload repetido e perda das mensagens mais novas ao ultrapassar 500 |
| P1 | pools da API e worker têm `max: 10`, sem timeouts explícitos | saturação silenciosa e espera indefinida |
| P1 | reconciliadores periódicos fazem buscas amplas | banco vira o caminho primário de entrega em vez de rede de recuperação |
| P1 | prompt ativo, wrapper, schemas e histórico produzem contexto grande; temperatura ativa é 0,7 | maior custo, latência e variabilidade |
| P1 | infraestrutura de regressão existe, mas não possui corpus ativo suficiente | gate sem cobertura prática |

## 4. Organização com subagentes

| Frente | Missão | Entregáveis | Dependências |
|---|---|---|---|
| Subagente Banco e Segurança | consultas, índices, pool, transações, roles e RLS | migrations aditivas, planos `EXPLAIN`, testes de isolamento e carga | observabilidade da Fase 0 |
| Subagente IA e Orquestração | verdade canônica, outcomes tipados, estado, templates e privacidade | runner compartilhado, confirmações determinísticas, suíte gold | contrato de agenda e journals |
| Subagente Operação e Rollout | métricas, flags, filas, canário, backup e runbooks | dashboards, gates de go/no-go e rollback testado | instrumentação comum |
| Agente integrador | revisar contratos entre as três frentes e impedir soluções paralelas | PRs pequenos, matriz de dependências e aceite final | entregas de todas as frentes |

Os subagentes podem trabalhar em paralelo apenas onde não alteram o mesmo contrato:

```text
Fase 0: métricas, backup e contratos
       |
       +--> Banco: leituras e índices v2 --------+
       |                                         |
       +--> IA: verdade e confirmação v2 --------+--> canário integrado
       |                                         |
       +--> Operação: flags, eventos e SLOs ------+
```

Mudanças em `scheduling/service.ts`, `process-message.ts`, migrations e contratos de ferramenta devem ter um único responsável por PR para evitar conflitos.

## 5. Sequência de execução

| Fase | Duração estimada | Saída obrigatória |
|---|---:|---|
| 0. Baseline e guardrails | 2–3 dias + 72 h de observação | métricas, backup restaurado, flags e contratos aprovados |
| 1. Quick wins de banco e verdade da agenda | 3–5 dias | consultas limitadas cedo, índices e duração canônica |
| 2. Confirmação determinística e privacidade | 4–7 dias | zero claim crítico sem evidência e payload sanitizado |
| 3. Leituras/eventos v2 e transação do Meet | 5–8 dias | polling reduzido e zero HTTP externo em transação |
| 4. Máquina de estados e gate único | 5–8 dias | ferramentas mínimas e toda publicação sujeita à regressão |
| 5. Privilégio mínimo, RLS piloto e filas | 4–7 dias | role restrita, isolamento testado e reconciliadores de recuperação |
| 6. Canário e expansão | contínua | rollout gradual com SLOs e rollback comprovado |

As durações são ordem de grandeza, não compromisso de calendário. Cada fase só avança após seus critérios de saída.

## 6. Fase 0 — medir antes de mudar

### OBS-01 — Observabilidade PostgreSQL

Implementar:

- habilitar `pg_stat_statements` em ambiente controlado, incluindo reinício planejado se exigido por `shared_preload_libraries`;
- medir tempo de espera e uso do pool por processo;
- medir duração e idade de transações;
- registrar query name estável na aplicação, sem parâmetros ou PII;
- alertar para deadlocks, transações ociosas, crescimento de tabelas/índices e queries p95/p99;
- definir `application_name` distinto para API, worker e migration.

Arquivos prováveis:

- `apps/backend/src/db/client.ts`;
- `apps/backend/src/config.ts`;
- deploy/observabilidade do PostgreSQL;
- `/ready` e métricas do backend.

Aceite:

- dashboard diferencia API, worker e migration;
- pool wait p95, conexões usadas e transações p99 são visíveis;
- nenhuma label de métrica contém tenant, conversa, telefone, e-mail ou conteúdo.

### OBS-02 — Timeouts seguros

Adicionar configuração explícita e testada para:

- `connectionTimeoutMillis`;
- `idleTimeoutMillis`;
- `statement_timeout`;
- `lock_timeout`;
- `idle_in_transaction_session_timeout`.

Não escolher valores finais sem baseline. Começar com limites conservadores por classe de operação e exceção explícita para migrations.

Aceite:

- query bloqueada falha de forma observável;
- API não espera conexão indefinidamente;
- migrations não herdam timeout inadequado;
- testes cobrem timeout, retry permitido e operação não idempotente sem retry.

### OPS-01 — Backup, restore e feature flags

Antes de qualquer migration:

- gerar backup consistente;
- restaurar em banco isolado e validar contagens/chaves;
- criar flags por tenant e kill switch global, sempre iniciando desligadas;
- persistir versão do deploy, migration e conjunto de flags.

Flags iniciais:

- `conversations_delta_v2`;
- `alerts_delivery_v2`;
- `evaluation_event_enqueue_v2`;
- `scheduling_meet_outbox_v2`;
- `ai_deterministic_confirmations_v2`;
- `evaluator_payload_redaction_v2`;
- `state_tool_gating_v2`;
- `compact_prompt_v2`.

## 7. Fase 1 — quick wins de banco e verdade canônica

### DB-01 — Limitar histórico antes das janelas

Alterar:

- `apps/backend/src/modules/messages/repository.ts`;
- `apps/backend/src/modules/messages/ai-follow-up.ts`.

Estratégia:

1. selecionar primeiro as 100 mensagens mais recentes com `ORDER BY created_at DESC, id DESC LIMIT 100`;
2. somente depois calcular o acumulado de caracteres;
3. devolver o histórico em ordem cronológica ao modelo;
4. manter a inclusão explícita da mensagem recém-inserida no CTE do turno atual.

Índice candidato:

```sql
CREATE INDEX idx_messages_conversation_recent
  ON messages (conversation_id, created_at DESC, id DESC);
```

Validar redundância com `idx_messages_conversation` antes de remover qualquer índice antigo. Remoção fica para ciclo posterior.

Aceite:

- histórico retornado é idêntico ao atual para conversas com até 100 mensagens;
- em conversa volumétrica, o plano não ordena/processa todo o histórico;
- p95 e buffers lidos melhoram ou não pioram;
- testes cobrem empate de `created_at`, mensagem atual, sticker e limite de caracteres.

### DB-02 — Índice de compromisso ativo

Antes da migration, detectar e resolver de forma auditada eventuais duplicidades ativas. Depois, criar a garantia física:

```sql
CREATE UNIQUE INDEX idx_appointments_one_active_per_lead
  ON scheduling_appointments (tenant_id, lead_id)
  WHERE status IN ('confirmado', 'reagendado');

CREATE INDEX idx_appointments_active_availability
  ON scheduling_appointments (tenant_id, unit_id, start_at)
  INCLUDE (end_at)
  WHERE status IN ('confirmado', 'reagendado');
```

O primeiro índice elimina a condição de corrida para compromisso ativo; o segundo atende as verificações de capacidade/disponibilidade.

Aceite:

- migration aborta com diagnóstico claro se o preflight encontrar duplicidades;
- `EXPLAIN (ANALYZE, BUFFERS)` usa os índices no banco volumétrico;
- nenhuma query de tenant A encontra compromisso do tenant B;
- criação concorrente permite exatamente um compromisso ativo por lead.

### DB-03 — Índice e semântica de recibos de alerta

Adicionar, após medir o plano:

```sql
CREATE INDEX idx_alert_receipts_user_alert
  ON system_alert_receipts (tenant_id, user_id, alert_id)
  INCLUDE (read_at, notified_at, created_at);
```

Primeiro passo funcional:

- impedir polling concorrente no cliente;
- desacelerar quando a aba estiver oculta;
- usar backoff com jitter após erro.

O desenho definitivo da Fase 3 cria recibos na emissão/atribuição do alerta ou usa uma projeção assíncrona, retirando `INSERT` em massa da leitura.

Aceite:

- endpoint de leitura não duplica recibos;
- seq scans repetitivos desaparecem no banco volumétrico;
- ordem, total, leitura e notificação permanecem idênticos.

### IA-01 — Uma única duração de reunião

Decisão de produto necessária:

- se o contato participa por 15 minutos e o calendário fica bloqueado por 60, modelar explicitamente `customer_duration_min` e `calendar_block_min`;
- caso contrário, usar somente `slot_duration_min`.

Depois da decisão:

- remover duração fixa de `instrução-newave-ia.md` e `prefilled-context.ts`;
- injetar o valor canônico retornado pela agenda;
- fazer a ferramenta retornar `start`, `end`, `duration_min`, timezone, status e link;
- validar que texto, evento e disponibilidade usam a mesma semântica.

Arquivos:

- `instrução-newave-ia.md`;
- `apps/backend/src/modules/messages/prefilled-context.ts`;
- `apps/backend/src/modules/scheduling/service.ts`;
- `apps/backend/src/modules/ai-router/tools.ts`;
- próxima migration, caso existam duas durações.

Aceite:

- 100% dos testes de 15 e 60 minutos mostram a duração configurada;
- texto e intervalo reservado nunca divergem;
- não resta literal de duração conflitante em prompt protegido ou template.

## 8. Fase 2 — fatos determinísticos e dados mínimos

### IA-02 — `ToolOutcome` tipado e confirmação por evidência

Criar contrato comum para agendar, reagendar, cancelar e qualificar:

```ts
type TransactionalOutcome = {
  journalId: string;
  status: "succeeded" | "failed" | "pending";
  action: string;
  occurredAt: string;
  facts: Record<string, string | number | boolean | null>;
};
```

Regras:

- o executor valida argumentos e precondições;
- o backend formata data/hora no timezone do workspace;
- o backend renderiza a parte factual da confirmação;
- o modelo pode apenas introduzir ou encerrar o texto;
- journal ausente, `pending`, `failed` ou inconsistente produz abstenção/falha;
- reprocessamento idempotente não duplica ação nem confirmação.

Substituir a proteção limitada ao link por composição completa de:

- data e hora;
- duração;
- unidade/atendente quando aplicável;
- status;
- link exato;
- instrução de falha ou próxima ação.

Arquivos:

- `apps/backend/src/modules/messages/process-message.ts`;
- `apps/backend/src/modules/ai-router/tool-executor.ts`;
- `apps/backend/src/modules/messages/repository.ts`;
- `apps/backend/src/modules/scheduling/service.ts`;
- testes de mensagem, executor e agenda.

Aceite:

- zero `SUCCESS_WITHOUT_TOOL_JOURNAL`;
- 100% das confirmações críticas coincidem com o outcome;
- zero sucesso visível após timeout ou falha;
- replay do mesmo evento produz no máximo um efeito e uma confirmação.

### IA-03 — Proveniência de claims

Persistir a relação entre mensagem do agente, journal e fatos usados. Não é necessário armazenar novamente todo o payload; guardar referência, tipo de claim e hash/valor normalizado.

Usos:

- validador final bloqueia claim sem evidência;
- painel pode indicar internamente a origem da confirmação;
- avaliador determinístico compara resposta e resultado;
- auditoria identifica qual ferramenta sustentou cada fato.

Aceite:

- toda mensagem com claim transacional tem journal concluído;
- exclusão/retenção respeita PII e integridade referencial;
- o contato nunca recebe IDs internos ou marcações de proveniência.

### PRIV-01 — Sanitização antes do provedor

Alterar `apps/backend/src/modules/agent-improvement/evaluator.ts` e consumidores relacionados:

- selecionar somente a janela necessária;
- impor limites totais de mensagens, caracteres e bytes;
- remover ou tokenizar telefone, e-mail, documento, nome quando dispensável e URL privada;
- substituir link Meet por presença/domínio/hash nas avaliações;
- usar whitelist de campos de resultado de ferramenta;
- tratar conteúdo do contato como dado não confiável, nunca instrução.

Structured output:

- adicionar `response_format/json_schema` opcional no router;
- manter validação Zod;
- uma tentativa controlada de reparo/retry;
- após nova falha, encerrar como erro técnico, sem aceitar JSON parcial.

Aceite:

- testes com PII conhecida encontram zero dado bruto no payload capturado;
- teto global é respeitado;
- replay não chama ferramentas reais;
- saída inválida após retry fica abaixo de 0,1% no canário.

### IA-04 — Contexto menor e temperatura controlada

Executar em replay:

- temperatura 0,1 e 0,2 contra o baseline 0,7;
- prompt por estado com apenas regras e ferramentas relevantes;
- histórico recente mais fatos estruturados;
- resumo, se usado, marcado como contexto não autoritativo.

Critério de escolha:

- redução de pelo menos 30% dos tokens de entrada p50;
- zero regressão crítica;
- regressão geral máxima de 1 ponto e por dimensão de 3 pontos.

## 9. Fase 3 — leituras por delta, eventos e Meet fora da transação

### DB-04 — Mensagens por cursor

Criar endpoint v2 com keyset pagination:

- carga inicial retorna as mensagens mais recentes, não as 500 mais antigas;
- `before` pagina para trás;
- `after` busca apenas deltas novos;
- ordenação estável por `(created_at, id)`;
- toda consulta valida conversa e tenant.

Alterar:

- `apps/backend/src/app.ts`;
- `apps/panel/app/conversas/page.tsx`;
- tipos e testes do painel/backend.

Aceite:

- conversa com mais de 500 mensagens mostra as mais recentes;
- paginação não perde nem duplica mensagens com timestamp igual;
- polling de 5 s deixa de retransmitir a thread inteira;
- acesso cruzado entre tenants retorna 404/403 sem revelar existência.

### OPS-02 — SSE/Redis como sinal, PostgreSQL como verdade

Após paridade do endpoint v2:

- publicar somente evento/cursor de “há mudança”;
- cliente reconecta com `Last-Event-ID`;
- ao receber evento, buscar deltas no PostgreSQL;
- manter polling adaptativo como fallback;
- Redis indisponível não perde mensagens ou alertas persistidos.

Aceite:

- reconexão recupera todos os deltas;
- evento duplicado não duplica item;
- queda do Redis aciona fallback e preserva consistência;
- mensagem ativa aparece em até 3 s por evento e até 15 s no fallback.

### SCHED-01 — Retirar Google Meet da transação

Estado alvo:

1. transação curta valida lead, unidade, capacidade e idempotência;
2. grava agendamento em estado de provisionamento e outbox;
3. worker chama Google Meet fora da transação;
4. nova transação persiste link/status;
5. falha é retentável e reconciliável;
6. confirmação final só ocorre após outcome concluído.

Requisitos:

- chave idempotente por agendamento/operação;
- estados explícitos como `provisioning`, `ready` e `failed`;
- compensação/cancelamento documentado;
- cache de token por tenant com expiração, sem depender de instância criada por chamada;
- timeouts e backoff limitados;
- reconciliador recupera commit seguido de falha no enqueue.

Arquivos:

- `apps/backend/src/modules/scheduling/service.ts`;
- `apps/backend/src/modules/scheduling/google-meet.ts`;
- worker/queue/outbox;
- próxima migration;
- testes de integração de agenda e Meet.

Aceite:

- zero HTTP externo dentro de transação;
- transação p99 abaixo de 2 s;
- timeout do Google não prende lock;
- retry não cria dois espaços nem dois agendamentos;
- falha entre commit e enqueue é recuperada.

### OPS-03 — Alertas orientados a evento

Redesenhar a leitura para não criar recibos em massa:

- criar recibos no evento de alerta ou projetá-los em job idempotente;
- entregar evento ao painel;
- manter `GET /alerts` como leitura pura;
- manter polling adaptativo como fallback.

Aceite:

- `GET /alerts` não faz `INSERT`;
- alerta não é perdido com worker/Redis indisponível;
- entrega p95 até 2 s por evento e até 10 s no fallback.

## 10. Fase 4 — máquina de estados e gate de publicação

### IA-05 — Ferramentas mínimas por estado

Derivar estado explícito a partir de dados persistidos:

```text
registration
  -> qualification
  -> offering_slots
  -> awaiting_confirmation
  -> booking
  -> managing_appointment
  -> handoff
```

Para cada estado:

- fornecer apenas ferramentas válidas;
- repetir as precondições no executor;
- orquestrar deterministicamente seleção inequívoca;
- para entrada ambígua, perguntar ou abster-se;
- nunca criar novo compromisso quando já existe um ativo.

Arquivos:

- `apps/backend/src/modules/messages/process-message.ts`;
- `apps/backend/src/modules/ai-router/tool-executor.ts`;
- `apps/backend/src/modules/ai-router/tools.ts`;
- novo módulo de estado, se necessário.

Aceite:

- zero ferramenta inesperada na suíte;
- toda transição possui teste unitário e de integração;
- qualificação concluída não é repetida;
- compromisso ativo bloqueia criação duplicada.

### IA-06 — Runner compartilhado e suíte gold

Extrair um runner de turno usado por produção e replay, com:

- relógio injetável;
- gateway de modelo injetável;
- ferramentas simuladas;
- mesmos validadores finais, notas dinâmicas e callbacks seguros;
- garantia estrutural de nenhum efeito real em replay.

Curar 30–50 casos sanitizados:

- duração 15/60 e timezone/DST;
- slot indisponível e seleção ambígua;
- link ausente, timeout e retry;
- reagendamento, cancelamento e compromisso ativo;
- formulário, mídia, handoff e prompt injection;
- mensagens duplicadas e idempotência.

Casos críticos usam asserts determinísticos para claims, ações e argumentos. Juiz LLM avalia apenas aspectos linguísticos.

### IA-07 — Gate único para qualquer publicação

Aplicar o mesmo gate a:

- proposta gerada;
- edição manual;
- template;
- troca de modelo;
- temperatura, tokens e reasoning;
- conjunto de ferramentas.

Alterar:

- `apps/backend/src/modules/agent-improvement/versions.ts`;
- `apps/backend/src/modules/agent-improvement/proposals.ts`;
- `apps/backend/src/modules/agent-improvement/replay.ts`;
- `apps/backend/src/modules/agent-improvement/replay-runner.ts`;
- rotas em `apps/backend/src/app.ts`.

O run aprovado deve carregar hash da suíte e versão do orquestrador. Mudança posterior invalida a autorização de publicação.

Gate:

- 100% dos casos críticos e altos;
- zero falha crítica;
- zero ferramenta inesperada;
- zero claim transacional sem evidência;
- regressão geral máxima de 1 ponto;
- regressão máxima de 3 pontos por dimensão.

Rollback continua sendo exceção auditada e pode ativar imediatamente uma versão estável anterior.

## 11. Fase 5 — privilégio mínimo, RLS piloto e filas

### SEC-01 — Separar papéis PostgreSQL

Criar:

- role de owner/migration sem login de runtime;
- role da aplicação apenas com `CONNECT`, `USAGE`, DML e sequências necessárias;
- credenciais distintas para testes e operação;
- rotação documentada.

Retirar do runtime:

- `SUPERUSER`;
- `CREATEDB`;
- `CREATEROLE`;
- `REPLICATION`;
- ownership que permita contornar controles.

Aceite:

- aplicação e worker executam toda a suíte com a role restrita;
- comandos administrativos falham;
- migration funciona apenas com a role própria;
- segredo de migration não é carregado pela API/worker.

### SEC-02 — RLS piloto

Começar por uma tabela de baixo acoplamento e alto valor de isolamento. Antes de ativar:

- encapsular toda operação tenant em transação;
- definir `SET LOCAL app.tenant_id`;
- garantir limpeza automática no retorno ao pool;
- criar política `USING` e `WITH CHECK`;
- testar jobs sem sessão de usuário e operações ROOT;
- usar role sem `BYPASSRLS`.

Aceite:

- testes tentam ler, inserir, atualizar e apagar dados de outro tenant;
- todos falham mesmo com query de aplicação sem filtro;
- pool reutilizado não herda tenant anterior;
- plano de desligamento da policy foi ensaiado.

Expandir RLS apenas após o piloto, tabela por tabela.

### OPS-04 — Filas como caminho primário

Para avaliação, follow-up e handoff:

- gravar outbox na mesma transação do estado;
- enfileirar por evento;
- manter reconciliador paginado como recuperação;
- reduzir frequência após comprovar entrega;
- medir examinados, enfileirados, deduplicados, idade e erros;
- persistir circuit breaker do avaliador em Redis/PostgreSQL, não apenas memória.

Aceite:

- queda entre commit e enqueue é recuperada;
- nenhum job é perdido ou executado duas vezes com efeito duplicado;
- reconciliador não faz varredura ampla contínua.

## 12. Testes obrigatórios

### Banco

- `EXPLAIN (ANALYZE, BUFFERS)` antes/depois com banco volumétrico;
- integração em banco vazio e upgrade;
- concorrência de compromisso ativo;
- paginação com timestamps iguais;
- pool saturation, lock timeout e statement timeout;
- tenant isolation e RLS com reuso de conexão.

### IA

- testes unitários de cada estado e ferramenta permitida;
- comparação exata entre outcome e confirmação;
- idempotência após retry/reentrega;
- payload capturado sem PII;
- 30–50 casos gold;
- prompt injection e conteúdo que tenta se passar por instrução;
- replay comprovadamente sem Evolution, agenda, e-mail ou escrita operacional.

### Operação

- build, typecheck, lint e suítes do monorepo;
- migration em banco novo e cópia restaurada;
- queda de PostgreSQL, Redis, worker, OpenRouter e Google Meet;
- reconexão SSE e fallback por polling;
- backup e restauração completos;
- rollback de flag e de versão da IA.

## 13. SLOs e critérios de parada

| Área | SLO |
|---|---|
| Webhook | aceite/enqueue ≥ 99,9%; p95 ≤ 300 ms |
| Leituras do painel | p95 ≤ 250 ms; erros < 1% |
| Pool PostgreSQL | espera p95 ≤ 50 ms; uso sustentado < 70% |
| Transações | p99 ≤ 2 s; zero HTTP externo dentro delas |
| Mensagens | atualização p95 ≤ 3 s por evento; fallback ≤ 15 s |
| Alertas | p95 ≤ 2 s por evento; fallback ≤ 10 s |
| Filas | job mais antigo ≤ 30 s; falha esgotada alertada ≤ 5 min |
| Avaliações | espera p95 ≤ 5 min; alerta aos 30 min |
| IA crítica | zero claim sem evidência; zero divergência nos casos críticos |
| Privacidade | zero PII/segredo em logs, métricas e payload automatizado do avaliador |

Parar rollout imediatamente se ocorrer:

- acesso cruzado entre tenants;
- PII ou segredo em log/payload indevido;
- mensagem, alerta ou agendamento perdido/duplicado;
- confirmação divergente da ferramenta;
- migration incompatível com a versão anterior;
- restore não validado;
- pool acima de 80%, 5xx acima de 1% por 5 minutos ou p95 25% pior por 15 minutos;
- fila principal parada.

## 14. Rollout e rollback

Ativar uma funcionalidade por vez:

1. testes sintéticos e banco volumétrico;
2. modo sombra, sem duplicar efeitos;
3. workspace interno por 24 horas;
4. um tenant de baixo risco por 48 horas;
5. 25% dos tenants por 48 horas;
6. 50% por 72 horas;
7. 100%, mantendo flag e fallback por pelo menos sete dias.

Rollback:

- comportamento: desligar flag por tenant ou kill switch global;
- IA: ativar nova versão `source='rollback'` baseada na última versão estável;
- schema: manter migrations aditivas e compatíveis; não fazer `down migration` emergencial;
- dados: restaurar backup somente diante de corrupção ou perda confirmada.

Runbook de incidente:

1. congelar rollout;
2. preservar logs e métricas sanitizados;
3. desligar a flag;
4. validar `/ready`, pool, filas e consistência;
5. executar conversa sintética sem efeitos reais;
6. reabrir somente após causa e recuperação confirmadas.

## 15. Ordem recomendada dos primeiros PRs

1. `OBS-01/OBS-02`: métricas, pool e timeouts, sem mudar comportamento.
2. `DB-01/DB-02`: histórico limitado cedo e índice de compromisso ativo.
3. `IA-01`: decisão e contrato único de duração.
4. `PRIV-01`: sanitização e teto antes do avaliador.
5. `IA-02/IA-03`: outcome, confirmação determinística e proveniência.
6. `DB-04`: endpoint de mensagens por cursor, inicialmente em sombra.
7. `SCHED-01`: outbox/saga do Google Meet.
8. `IA-05/IA-06/IA-07`: estado, corpus gold e gate universal.
9. `SEC-01`: role de runtime restrita.
10. `SEC-02`: RLS piloto após a disciplina de contexto por transação.

Não iniciar RLS global, SSE, saga do Meet e refatoração do runner no mesmo PR. São mudanças independentes e precisam de rollback isolado.

## 16. Matriz de evidências (2026-07-26)

| Critério da seção 16 | Situação | Evidência |
|---|---|---|
| consultas críticas com baseline, plano validado e SLO | atendido | `docs/audits/DB_VOLUME_AUDIT_2026-07-26.md`; DB-01 de 715 → 104 buffers e 12,197 → 0,738 ms |
| polling não retransmite coleções inteiras nem escreve na leitura | atendido | DB-04 por cursor keyset; `GET /alerts` como leitura pura com recibos projetados na emissão |
| nenhuma chamada externa dentro de transação | atendido | SCHED-01: Meet em reserva + outbox + worker + reconciliação; testes de agenda/Meet verdes |
| role de runtime sem privilégios administrativos | atendido | `atendon_app` sem `SUPERUSER`, `CREATEDB`, `CREATEROLE`, `REPLICATION` ou `BYPASSRLS`; `postgres-roles.integration.test.ts` |
| isolamento adicional validado em piloto | atendido | RLS de `agent_message_transaction_claims` **ativado** em 2026-07-26 (`relrowsecurity=t`, `relforcerowsecurity=t`); isolamento revalidado com a role runtime na seção 18 |
| dados enviados ao avaliador mínimos e sanitizados | atendido | PRIV-01: sanitização e teto de payload antes do avaliador; structured output com uma reparação |
| confirmação transacional derivada de journal concluído | atendido | IA-02/IA-03: `ToolOutcome` tipado, claims com proveniência, composer determinístico |
| toda publicação sujeita ao mesmo gate | atendido | IA-07: gate universal com hashes de versão, suíte e orquestrador |
| suíte gold cobrindo os fluxos críticos | atendido | 36 casos Newave sanitizados; replay determinístico com falha fechada nos casos críticos |
| canário e rollback executados | **pendente** | exige janela operacional: experimento IA-04 real, canário de 24 h, tenant de baixo risco por 48 h, rollout de 25/50/100% e ensaio de rollback |

Validação de código em 2026-07-26, sem deploy: `lint` e `typecheck` verdes,
painel com 59/59 testes, backend com 600/600 testes em banco descartável,
`build` verde e `migrate` sem migration nova nem divergência de checksum.

O que impede a conclusão formal é exclusivamente evidência temporal de
produção, descrita em `docs/HANDOFF_PAUSA_PLANO_BANCO_IA_2026-07-26.md`.

## 17. Definição de concluído

O plano estará concluído quando:

- consultas críticas têm baseline, plano validado e SLO;
- polling não retransmite coleções inteiras nem escreve durante leitura;
- nenhuma chamada externa ocorre dentro de transação;
- role de runtime opera sem privilégios administrativos;
- isolamento adicional foi validado em piloto;
- dados enviados ao avaliador são mínimos e sanitizados;
- toda confirmação transacional deriva de journal concluído;
- todas as formas de publicação passam pelo mesmo gate;
- suíte gold cobre os fluxos críticos;
- canário e rollback foram executados, não apenas documentados.

## 18. Matriz final de evidências do deploy (2026-07-26, passos 5–13)

Execução dos passos 5 a 13 de `docs/HANDOFF_PAUSA_PLANO_BANCO_IA_2026-07-26.md`.
Todas as feature flags permaneceram OFF e nenhum tenant real foi ativado.

| Passo | Ação | Resultado | Evidência |
|---|---|---|---|
| 5 | Recriar PostgreSQL e reprovisionar roles | verde | container recriado e `healthy`; `provision-roles.sh` concluiu com `roles provisioned for database atendon` |
| 6 | Validar `shared_preload_libraries`, extensão, roles e `/ready` | verde | `shared_preload_libraries=pg_stat_statements`; extensões `pg_stat_statements`, `pgcrypto`, `plpgsql`; `atendon_app` sem `SUPERUSER`/`CREATEDB`/`CREATEROLE`/`REPLICATION`/`BYPASSRLS`; `/ready` = `ready` |
| 7 | Reiniciar API e worker com o build novo | verde | `Server listening at http://127.0.0.1:3110`; `restart_time` estável e `unstable_restarts=0`; `/ready` passou a expor `worker_inbound`, `worker_meeting_provisioning` e `worker_meeting_contact_delivery`, confirmando o artefato novo |
| 8 | Ativar o RLS piloto | verde | `relrowsecurity=t` e `relforcerowsecurity=t`; policy `agent_message_transaction_claims_tenant_isolation` com `USING`/`WITH CHECK` sobre `app.tenant_id` |
| 9 | Isolamento RLS com a role runtime | verde | `atendon_app` sem `BYPASSRLS` e sem a role owner; sem contexto → 0 linhas e `INSERT` recusado; tenant correto → 1 linha; tenant cruzado → 0 linhas e `WITH CHECK` recusa a gravação; `SET LOCAL` não vaza para a transação seguinte da mesma conexão; nada persistiu (`count=0`) |
| 10 | `snapshot:deploy` com flags OFF | verde | 8 definições OFF e 0 overrides de tenant; snapshot `atendon-20260726-schema-0081`, migration `0081_operational_event_delivery.sql`, hash `4cf2b2d0fed368479afc6a1bc5c7c6e5844139ba17d9600e487ba34872839b9c` |
| 11 | Backup pós-deploy 0081 e restore completo | verde após correção | dump `atendon-atendon-20260726T030338608Z.dump`, SHA-256 `94fb5bf01dabef336ee8c322f0f2a0ca76af58652855a49a7dd86ddf0d6eb448`; restore `status: verified`, 13/13 contagens `matches: true`, 342 constraints e 123 FKs sem inválidas, banco descartável removido |
| 12 | Atualização incremental do Graphify | verde | `rtk graphify update .` (exit 0): 387 arquivos re-extraídos, 2.576 → 3.704 nós, 6.198 arestas, 22 hiperarestas e 202 comunidades; `graph.json`, `graph.html` e `GRAPH_REPORT.md` regravados |
| 13 | Atualizar o plano com a matriz final | verde | esta seção e a atualização da seção 16 |
| — | `./build.sh` | verde (exit 0) | `lint`, `typecheck`, backend 69 arquivos / 600 testes, painel 16 arquivos / 59 testes, build de produção, `migrate` sem migration nova, PM2 reiniciado e readiness de API (`/ready`) e painel (`/login` = 200) |

Estado final verificado após o `build.sh`: `shared_preload_libraries=pg_stat_statements`,
`relrowsecurity=t`/`relforcerowsecurity=t`, `atendon_app` e `atendon_migration`
sem `BYPASSRLS`, 81 migrations aplicadas com topo em `0081_operational_event_delivery.sql`,
zero ocorrências de erro de policy nos logs de API e worker e os quatro cenários
de isolamento do passo 9 revalidados.

### Duas correções exigidas pelo `build.sh`

1. `atendon_test` estava parado na migration `0071` e continha resíduo de
   fixture de 2026-07-23 — nove compromissos ativos no mesmo lead sintético,
   exatamente o padrão que a migration `0072` passou a proibir. O conflito foi
   resolvido cancelando as oito duplicatas mais novas e preservando a mais
   antiga; nenhuma linha de produção foi tocada e o banco não foi recriado.
2. `apps/backend/tests/postgres-roles.integration.test.ts` exigia
   `rolbypassrls: false` nas três roles. A asserção passou a ser específica:
   apenas o owner (`NOLOGIN`) tem `BYPASSRLS`; as duas roles de login continuam
   sem ele.

### Correção necessária no passo 11: `FORCE RLS` versus backup

A ativação do passo 8 quebrou o backup do passo 11. Com
`FORCE ROW LEVEL SECURITY`, o dono da tabela também fica sujeito à policy, e o
`pg_dump --role=atendon_owner` falhou fechado:

```
ERROR: query would be affected by row-level security policy for table
"agent_message_transaction_claims"
```

Falhar fechado é o comportamento correto — um backup silenciosamente incompleto
seria pior. A correção mínima foi conceder `BYPASSRLS` **apenas** a
`atendon_owner` em `deploy/postgres/provision-roles.sh`:

- `atendon_owner` é `NOLOGIN` e só é alcançado por `SET ROLE` a partir de
  `atendon_migration`, que é exatamente o caminho do backup;
- `atendon_app` continua `NOBYPASSRLS` e continua sem ser membro de
  `atendon_owner` (`pg_has_role('atendon_app','atendon_owner','MEMBER')` = `f`);
- o piloto foi revalidado após a mudança e os quatro cenários do passo 9
  continuam passando.

Alternativas descartadas: `NO FORCE ROW LEVEL SECURITY` contraria o item 4 do
runbook; `pg_dump --enable-row-security` produziria um dump silenciosamente
incompleto; dumps com o superusuário `atendon` reintroduziriam o privilégio
administrativo que a Fase 5 removeu.

### Pendências inalteradas

Os passos 5–13 não alteram a seção 17. Continuam pendentes de janela e decisão
operacional: experimento IA-04 real contra o provedor, canário interno de 24 h,
tenant de baixo risco por 48 h, rollout de 25/50/100%, observação real dos SLOs
e ensaio de rollback de flag e versão.
