# Auditoria técnica e plano priorizado — 2026-07-13

## Escopo e linha de base

Auditoria integral do monorepo AtendON, cobrindo painel, API, worker, PostgreSQL, Redis/BullMQ, Evolution API, OpenRouter, autenticação/RBAC, multi-tenancy, deploy e fluxos de produto. Billing, pagamentos, assinaturas, cobranças e módulos financeiros estão explicitamente fora do escopo.

Linha de base anterior às mudanças deste ciclo:

- 162 arquivos suportados, cerca de 353 mil palavras; grafo com 1.214 nós e 1.871 relações.
- 163 testes passando (158 backend e 5 painel).
- Typecheck, build de produção e `npm audit --omit=dev` passando.
- Cobertura forte de serviços e integrações do backend, mas somente 5 testes no painel e ausência de E2E visual/acessível.

Validação após cinco rodadas de implementação e duas auditorias finais independentes:

- 226 testes passando: 208 no backend e 18 no painel.
- Typecheck e build de produção passando em execução sequencial.
- Migrações reaplicadas de forma idempotente no banco exclusivo de testes.
- `npm audit --omit=dev` sem vulnerabilidades; Compose, scripts shell e diff validados.
- Grafo atualizado para 1.695 nós, 2.617 relações e 103 comunidades.
- Nenhum P0/P1 remanescente foi confirmado nas auditorias finais de segurança, backend, UX e produto.

## Arquitetura atual

```text
WhatsApp / Evolution
        │ webhook
        ▼
Fastify API ──► PostgreSQL
        │
        ├──► BullMQ / Redis ──► Worker ──► MessageProcessor
        │                                  ├──► OpenRouter
        │                                  ├──► ferramentas de lead/agenda
        │                                  └──► Evolution (resposta/presença)
        │
Next.js Panel ── cookie JWT + RBAC ──► Fastify API
```

O isolamento lógico usa `tenant_id` nas consultas e memberships por workspace. Sessões JWT são revogáveis por `session_version`. O grafo apontou como maiores pontos de acoplamento `api()`, `MessageRepository`, `config`, `WhatsAppSessionManager` e `Shell()`.

## Plano priorizado

### P0 — segurança e integridade

| Item | Estado | Evidência / decisão |
|---|---|---|
| Restringir portas de PostgreSQL, Redis e Evolution ao host local | Implementado | Publicações do `docker-compose.yml` agora usam `127.0.0.1`; API e painel de produção usam loopback atrás do Nginx. |
| Remover payloads de mensagens dos logs | Implementado | Webhooks registram somente evento, instância, chaves e contagem, sem `rawData`/conteúdo. |
| Remover PII e segredos residuais dos logs | Implementado | Ferramentas, worker, SMTP e presença não registram conteúdo, telefone ou destinatário; queries são removidas e tokens de convite na URL são mascarados. |
| Corrigir destino do handoff | Implementado | `pauseForHandoff()` usa e valida `tenants.attendant_phone`, não o número da sessão/bot. |
| Impedir escalada por convite/promoção para ADMIN | Implementado | Papel alvo deve caber nas permissões do ator; somente OWNER/ROOT atribui ADMIN; OWNER continua protegido. |
| Preservar configurações estratégicas exclusivas do ROOT | Implementado | Agente/configuração da IA (incluindo provedor e chave), Humanização, Funções, Chaves de API do tenant e Uso exigem `requireRootWorkspace` na API e sessão ROOT assistida no painel. Permissões de OWNER, ADMIN ou funções customizadas nunca liberam essas áreas. |
| Garantir entrega durável de handoff | Implementado | Pausa e outbox são transacionais; fila tem retry/backoff, estado de entrega e reconciliador de pendências após reinício/falha de Redis. |
| Recuperar provisionamento parcial da Evolution | Implementado | Cache positivo só é gravado após webhook e settings; falha invalida o cache e o próximo ciclo reconcilia tudo. |
| Tornar envio de mensagens e ferramentas idempotentes | Implementado | Outbox/journal persistentes, leases recuperáveis e `Idempotency-Key` obrigatório no envio manual impedem efeitos duplicados e colisão entre IA e humano. |

### P1 — operação e valor percebido

| Item | Estado | Próximo resultado |
|---|---|---|
| Busca de conversas por nome/telefone | Implementado | Busca literal parametrizada e isolada por tenant, com debounce e estados vazios coerentes. |
| Separar handoff real de pausa manual no dashboard | Implementado | Pausa manual não infla mais “Aguardando humano”. |
| Traduzir estados e motivos técnicos | Implementado | Leads, handoffs, convites e auditoria usam rótulos legíveis; detalhes técnicos sensíveis são apresentados de forma controlada. |
| Corrigir ciclo de presença WhatsApp | Implementado | Webhook não espera retries e managers efêmeros não criam timers periódicos vazados. |
| Controles essenciais no mobile | Implementado | Troca de workspace, perfil e logout permanecem acessíveis abaixo de 700 px. |
| Limitar/deduplicar toasts e corrigir estados enganosos | Implementado | Alertas são persistentes por usuário, o toast aparece uma vez, expira e deduplica; reloads parciais não transformam gravações concluídas em falso erro. |
| Completar ações manuais de leads | Implementado | Status com máquina de transições, responsável, próxima ação e notas internas têm RBAC, isolamento tenant, evento e auditoria transacional. |
| Completar operação da agenda | Implementado | Criação, reagendamento, cancelamento, conclusão e no-show têm permissões próprias, estados confiáveis e tolerância a falhas parciais no carregamento. |
| Responsável, aceite e resolução da conversa | Implementado | Claim, transferência, desatribuição, reabertura e resolução são auditados; filtros minhas/sem responsável e métricas de SLA fecham a fila humana. |
| Fuso horário por workspace | Implementado | Campo IANA, conversão centralizada e testes de horário inexistente/ambíguo e transições de DST. |
| Alinhar permissões declaradas e rotas/UI | Implementado | Auditoria, Conversas, Agenda, Conexão, Catálogo e Leads usam RBAC de workspace coerente entre rota e interface; Agente, Humanização, Funções, Chaves de API e Uso permanecem exclusivamente ROOT. |
| Isolar banco de testes do banco da aplicação | Implementado | Runner e migração usam `TEST_DATABASE_URL`; produção bloqueia URL ausente ou igual ao banco da aplicação. |
| TLS documentado e verificável | Implementado na operação | Nginx/Certbot, renovação, headers de proxy e endpoints de health/readiness estão documentados; a emissão continua sendo etapa do deploy. |

### P2 — robustez e maturidade

- Migrações com ledger, checksum, lock e transação por arquivo. **Implementado e testado em banco novo e legado.**
- Rate limiter Redis atômico via Lua. **Implementado e testado sob concorrência.**
- Readiness com PostgreSQL, Redis, fila e heartbeat do worker. **Implementado; o build aguarda saúde após restart.**
- Chaves de API do tenant com scopes por operação, expiração, segredo one-shot, rotação em duas fases, revogação e auditoria. **Implementado.**
- `DATA_ENCRYPTION_KEY` separado do segredo JWT, com chave anterior e CLI de rotação. **Implementado.**
- FKs compostas e/ou RLS como defesa adicional de isolamento tenant.
- Contatos 360º, tags e pipeline visual; notas e follow-ups essenciais já foram implementados.
- Respostas rápidas e vistas salvas; alertas persistentes por usuário já foram implementados.
- Simulador do agente/humanização antes de publicar configurações.

## Resultado da auditoria final de UX e segurança

As verificações finais não encontraram P0/P1 remanescente. Os últimos quatro P1 foram fechados com regressões automatizadas:

- rotação de chave em duas fases, mantendo a anterior ativa até revogação explícita;
- proteção do segredo one-shot contra sobrescrita ou descarte sem confirmação;
- confirmação de nota/follow-up pela resposta persistida, separando falha posterior de reload;
- schema público estrito de lead, impedindo que o scope de upsert altere status ou burle transições.

O catálogo respeita leitura/gestão, o gráfico de uso tem alternativa acessível e as tabelas administrativas adotam apresentação responsiva. Permanecem como evolução P2, não como defeito bloqueante: defesa adicional com RLS/FKs compostas, respostas rápidas, vistas salvas, tags/pipeline e simulador do agente.

## Métricas operacionais recomendadas

- Backlog humano total, não atribuído e acima do SLA.
- Tempo mediano/P90 até primeira resposta humana e idade do handoff mais antigo.
- Conversas novas, resolvidas, reabertas e resolução pela IA sem intervenção.
- Leads criados, parados, tempo por etapa e conversão para agendamento.
- Ocupação, antecedência, reagendamento, cancelamento e no-show por unidade.
- Carga por operador e falhas de envio/entrega.

As métricas por operador dependem da atribuição de conversas. Métricas confiáveis de resolução dependem de eventos explícitos de claim/close.

## Critério dos próximos ciclos

Cada ciclo deve: reproduzir o problema, implementar o menor conjunto completo que resolve o fluxo, adicionar teste de regressão proporcional ao risco, executar testes/typecheck/build/audit e repetir a auditoria. O objetivo não é apenas deixar os checks verdes, mas fechar ciclos operacionais inteiros para atendentes e gestores.
