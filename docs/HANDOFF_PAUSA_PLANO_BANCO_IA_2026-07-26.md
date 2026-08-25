# Handoff da pausa — Plano Banco e IA Confiável

Data da pausa: 2026-07-26 (UTC)

Documento principal: `docs/PLANO_BANCO_E_IA_CONFIAVEL_2026-07-25.md`

## Estado seguro no momento da pausa

> Registro histórico. Superado pela seção "Execução dos passos 5–13 em
> 2026-07-26": o PostgreSQL já foi recriado, API e worker já rodam o build novo
> e o RLS piloto já está ativo.

- API, worker, painel, PostgreSQL, Redis e Evolution continuam em execução.
- `GET http://127.0.0.1:3110/ready` responde `ready`, com PostgreSQL, Redis,
  fila e worker saudáveis.
- Nenhuma feature flag foi ativada.
- Nenhuma versão candidata de IA foi publicada.
- O RLS piloto de `agent_message_transaction_claims` permanece
  **desativado**, de propósito, até o novo build ser implantado. A policy está
  instalada e `relforcerowsecurity=true`.
- A API e o worker do PM2 ainda executam o build anterior. Não reiniciar nem
  ativar RLS antes de concluir os passos pendentes abaixo.
- `.env`, `.env.migration` e `.env.test` estão com modo `0600`.
- `DEPLOY_VERSION` em `.env` já foi preparado como
  `atendon-20260726-schema-0081`, mas ainda não houve build/restart/snapshot
  desse deploy.
- Os dois subagentes que tratariam as últimas falhas foram interrompidos antes
  de editar. As duas correções continuam pendentes.

## Entregue

### Banco, backup e observabilidade

- DB-01: histórico agora é limitado antes de janelas/`UNION ALL`.
- DB-02: unicidade física de compromisso ativo e índices de capacidade.
- DB-03: receipts de alertas projetados na emissão e leitura pura.
- DB-04: mensagens recentes e deltas por cursor keyset estável.
- Timeouts separados, `application_name`, métricas de pool/query/transação,
  filas/outboxes, SSE, Redis e PostgreSQL.
- Endpoint ROOT de métricas sem SQL, tenant, PII ou segredo.
- Infraestrutura preparada para `pg_stat_statements`.
- Credenciais separadas para runtime, migration e testes.
- Roles `atendon_owner`, `atendon_migration` e `atendon_app`, com runtime sem
  `SUPERUSER`, `CREATEDB`, `CREATEROLE`, `REPLICATION` ou `BYPASSRLS`.
- Backup usa a role owner por meio da credencial de migration e inclui tabelas
  críticas, claims e outboxes.
- RLS piloto e helper transacional com `SET LOCAL app.tenant_id`.

### IA, privacidade e publicação

- Duração canônica de reunião.
- `ToolOutcome` tipado, journal idempotente e confirmação baseada em evidência.
- Claims transacionais com proveniência por mensagem/ação.
- Composer determinístico bloqueia falso sucesso.
- Sanitização e teto de payload antes do avaliador; structured output com uma
  reparação controlada.
- Máquina de sete estados e ferramentas mínimas por estado, sob flag OFF.
- Runner compartilhado entre produção e replay, com relógio/modelo/ferramentas
  injetáveis.
- Suíte gold Newave com 36 casos sanitizados.
- Replay valida deterministicamente ação observável, nome/ordem/argumentos de
  ferramentas e conjunto exato de claims. Casos críticos/altos sem contrato
  falham fechados.
- Gate universal de publicação para edição manual, template, proposta, modelo,
  parâmetros e ferramentas, com hashes de versão/suíte/orquestrador.
- IA-04 possui executor offline para matriz de 36 casos × 6 variantes
  (`0.1/0.2/0.7`, legacy/compact). Fixtures sintéticas são inelegíveis para
  promoção. **Nenhuma medição real com provedor foi executada.**

### Operação, realtime, Meet e filas

- Google Meet foi retirado das transações e convertido em
  reserva + outbox + worker + reconciliação.
- Resultado ambíguo do provedor vira `uncertain`, sem retry cego.
- Entrega tardia do link ao contato usa outbox durável e idempotente.
- SSE serve apenas como sinal; PostgreSQL continua sendo a verdade, com
  `Last-Event-ID` e polling adaptativo como fallback.
- Handoff e follow-up enfileiram no caminho primário pós-commit e têm
  recuperação keyset.
- Avaliação event-driven sob `evaluation_event_enqueue_v2`; flag OFF preserva
  o caminho legado e flag ON exclui o tenant da varredura antiga.
- Circuit breaker do avaliador persistido no Redis.
- Erros de enqueue são classificados antes de persistir, sem mensagem bruta.
- Reconciliadores possuem limites, paginação e métricas allowlist.

## Migrations aplicadas e congeladas

- Banco principal está em `0081_operational_event_delivery.sql`.
- Ledger confirmado com SHA-256:
  `43a494c6be75043aba169d5e2b65512250079cefbdaac1589552b98ea0fda255`.
- `0078_meeting_contact_delivery_outbox.sql` está congelada com SHA-256:
  `756e1a7585e2b2f7be3d8eabc6da639e04b345148e9ad8e846f8e31df60308ab`.
- Não editar `0078` nem `0081`. Qualquer correção de DDL deve ser uma nova
  migration `0082`.
- `0080` deixa o RLS desativado para compatibilidade migration → restart.

## Evidências já verdes

- `npm run typecheck`: verde.
- `npm run lint`: verde.
- Painel: 16 arquivos, 59/59 testes.
- Banco volumétrico:
  - 50.000 mensagens;
  - 25.000 mensagens com o mesmo timestamp;
  - 10.000 alertas e receipts;
  - 16.001 compromissos;
  - DB-01/02/03/04 aprovados;
  - cursor sem perda/duplicação;
  - concorrência deixou exatamente um compromisso ativo;
  - isolamento multi-tenant aprovado.
- DB-01: 715 → 104 buffers e 12,197 → 0,738 ms no ensaio aceito.
- Fresh/upgrade migrations: 3/3.
- OPS-04 consolidado: 50/50 testes focados.
- IA runner/gold/gate: suítes focadas verdes, incluindo 146 testes na primeira
  extração e 31 testes adversariais na correção final.
- Backup pré-deploy de schema 0080 criado e restaurado com sucesso:
  - manifesto:
    `/home/deploy/backups/atendon/postgresql/2026-07-26-plan/atendon-atendon-20260726T021917818Z.manifest.json`;
  - dump:
    `/home/deploy/backups/atendon/postgresql/2026-07-26-plan/atendon-atendon-20260726T021917818Z.dump`;
  - SHA-256:
    `6bc556914080c1e5b9f7fabe3d9a54ac6210a652175e389e4025dc113d212bbc`;
  - restore validou migration 0080, contagens, zero constraint inválida e
    removeu o banco descartável.
- Relatório volumétrico:
  `docs/audits/DB_VOLUME_AUDIT_2026-07-26.md`.

## Retomada de 2026-07-26 — as duas falhas foram corrigidas

Ambas as correções abaixo foram aplicadas e validadas. A suíte completa
descartável passou a terminar com **600/600 testes verdes** (69 arquivos),
removendo o banco temporário ao final.

- Correção 1 (`apps/backend/tests/google-meet-scheduling.integration.test.ts`):
  a carga por closer agora cria oito leads sintéticos distintos
  (`round-robin-load`) em uma única CTE e associa um compromisso ativo a cada
  um. O índice `idx_appointments_one_active_per_lead` continua intacto, e a
  intenção do teste é preservada: 3 compromissos para um closer, 5 para o
  outro, contagem prévia de 4/5 e rotação determinística do empate.
- Correção 2 (`apps/backend/src/modules/messages/repository.ts`): a supressão
  do outbox de entrega tardia deixou de ser condicionada a
  `scheduling_meet_outbox_v2`. O helper `meetingContactDeliveryEnabled` foi
  removido. As demais precondições continuam exigidas: resposta normal
  durável, URL exata dentro do texto entregue, estado `pending`/`processing` e
  `attempted_at IS NULL`. Um outbox criado com a flag ON continua sendo
  suprimido depois que a flag ou o kill switch é desligado, e a reconciliação
  não reenvia o mesmo link.
- Cobertura adicional em `apps/backend/tests/idempotent-effects.integration.test.ts`:
  novo caso com override de tenant `scheduling_meet_outbox_v2=false` que
  verifica, na mesma resposta, supressão do outbox sem tentativa e ausência de
  supressão do outbox com `attempted_at` preenchido (envio ambíguo).

### Evidências desta retomada

| Verificação | Resultado |
|---|---|
| `npm run lint` | verde |
| `npm run typecheck` | verde |
| `npm test -w @atendon/panel` | 16 arquivos, 59/59 |
| `npm run test:disposable -w @atendon/backend` | 69 arquivos, 600/600 |
| `npm run build` | verde (backend + painel) |
| `npm run migrate -w @atendon/backend` | sem migration nova e sem divergência de checksum |

Nenhum deploy foi executado: não houve recriação do PostgreSQL, restart de
PM2, ativação de RLS, `snapshot:deploy` nem backup pós-deploy.

`rtk graphify . --update` não pôde ser executado: o CLI exige uma chave de
LLM (`GEMINI_API_KEY`, `ANTHROPIC_API_KEY` ou equivalente) que não está
configurada no ambiente.

## Registro original das duas falhas

### 1. Fixture de rotação de closers viola a nova unicidade

Arquivo:
`apps/backend/tests/google-meet-scheduling.integration.test.ts`

Teste:
`assigns the least-loaded closer and rotates the tie deterministically`

Problema:

- a fixture insere oito compromissos ativos no mesmo lead;
- `idx_appointments_one_active_per_lead` rejeita corretamente o segundo;
- não afrouxar o índice nem o runtime.

Correção esperada:

- criar leads sintéticos distintos para os compromissos usados apenas para
  formar a carga por closer;
- manter a intenção do teste: 3 atribuições para um closer, 5 para o outro e
  rotação determinística do empate.

### 2. Flag OFF pode impedir a supressão de um outbox Meet já existente

Arquivos:

- `apps/backend/src/modules/messages/repository.ts`;
- `apps/backend/tests/idempotent-effects.integration.test.ts`.

Falha:
`journals a late-ready Meet link and suppresses fallback only after the normal reply is durable`

Problema:

- `recordAgentReply` só suprime o outbox de entrega tardia quando
  `scheduling_meet_outbox_v2` está ON;
- se a flag/kill switch for desligada depois de um outbox ter sido criado, uma
  resposta normal já entregue com o link exato pode não suprimir o outbox;
- o reconciliador poderá enviar o mesmo link outra vez.

Correção esperada:

- a supressão segura de outbox já persistido deve ocorrer independentemente do
  estado atual da flag;
- continuar exigindo resposta normal durável, URL exata, estado
  `pending/processing` e `attempted_at IS NULL`;
- adicionar casos para flag OFF/kill switch e confirmar que não há supressão
  após tentativa de envio ambígua.

## Ordem segura para retomar

Os passos 1 a 13 foram concluídos em 2026-07-26, seguidos de `./build.sh` com
exit 0. A matriz final está na seção 18 de
`docs/PLANO_BANCO_E_IA_CONFIAVEL_2026-07-25.md`.

1. ~~Corrigir somente as duas falhas acima.~~ (concluído)
2. ~~Rodar os testes focados em banco UUID descartável.~~ (concluído)
3. ~~Rodar novamente:~~ (concluído)

   ```bash
   rtk npm run lint
   rtk npm run typecheck
   rtk npm test -w @atendon/panel
   rtk npm run test:disposable -w @atendon/backend
   rtk npm run build
   ```

4. ~~Confirmar migration/ledger sem mudança de checksum:~~ (concluído)

   ```bash
   rtk npm run migrate -w @atendon/backend
   ```

5. ~~Recriar somente o PostgreSQL para carregar `pg_stat_statements`:~~ (concluído)

   ```bash
   rtk docker compose --env-file .env --env-file .env.migration \
     up -d --force-recreate postgres
   rtk docker compose --env-file .env --env-file .env.migration \
     exec -T postgres sh /docker-entrypoint-initdb.d/20-provision-atendon-roles.sh
   ```

6. ~~Validar `shared_preload_libraries`, extensão, roles e `/ready`.~~ (concluído)
7. ~~Reiniciar API e worker do PM2 com o build novo; validar uptime/logs/`/ready`.~~ (concluído)
8. ~~Ativar o RLS piloto conforme
   `docs/runbooks/transaction-claims-rls-pilot.md`.~~ (concluído)
9. ~~Repetir os testes de isolamento RLS com role runtime:
   sem contexto, tenant correto, tenant cruzado e reuso de pool.~~ (concluído)
10. ~~Executar `snapshot:deploy` com todas as flags ainda OFF.~~ (concluído)
11. ~~Criar backup pós-deploy de schema 0081 e repetir restore completo.~~
    (concluído, após conceder `BYPASSRLS` somente à role `atendon_owner`)
12. ~~Rodar a atualização incremental do Graphify.~~ (concluído)

    A forma `rtk graphify . --update` cai no build completo e exige chave de
    LLM. O subcomando correto para a atualização incremental é o que não precisa
    de LLM:

    ```bash
    rtk graphify update .
    ```

    Resultado: 387 arquivos re-extraídos, 2.576 → 3.704 nós, 6.198 arestas e 202
    comunidades. A extração semântica de documentos/imagens continua exigindo
    `GEMINI_API_KEY` ou equivalente e não foi executada.

13. ~~Atualizar o plano principal com a matriz final de evidências.~~ (concluído,
    seção 18 de `docs/PLANO_BANCO_E_IA_CONFIAVEL_2026-07-25.md`)

## Execução dos passos 5–13 em 2026-07-26

Estado ao final: PostgreSQL recriado com `shared_preload_libraries=pg_stat_statements`,
API e worker rodando o build novo, RLS piloto **ativo**, todas as feature flags
ainda OFF, snapshot `atendon-20260726-schema-0081` registrado e backup pós-deploy
verificado por restore.

Novo backup pós-deploy preservado em
`/home/deploy/backups/atendon/postgresql/2026-07-26-postdeploy/`:

- dump `atendon-atendon-20260726T030338608Z.dump`;
- SHA-256 `94fb5bf01dabef336ee8c322f0f2a0ca76af58652855a49a7dd86ddf0d6eb448`;
- restore com `status: verified`, 13/13 contagens coincidentes, 342 constraints
  e 123 FKs sem inválidas, banco descartável removido.

Alteração de infraestrutura feita durante o passo 11: `deploy/postgres/provision-roles.sh`
passou a criar `atendon_owner` com `BYPASSRLS`. Sem isso, `FORCE ROW LEVEL SECURITY`
faz o `pg_dump --role=atendon_owner` falhar fechado e o backup fica impossível.
`atendon_app` continua `NOBYPASSRLS` e sem ser membro de `atendon_owner`, e os
quatro cenários de isolamento foram revalidados depois da mudança.

O wrapper temporário PostgreSQL 16 em `/tmp/atendon-backup-wrapper.q0NYwC/` já
pode ser removido: o backup e o restore pós-deploy foram concluídos.

## Pendências que exigem janela/decisão operacional

Mesmo depois dos passos técnicos, a definição de concluído do plano exige
evidência temporal que não foi fabricada:

- experimento IA-04 real contra o provedor, com custo controlado e corpus
  sanitizado;
- canário interno por 24 horas;
- tenant de baixo risco por 48 horas;
- rollout progressivo de 25%, 50% e 100%;
- observação real dos SLOs durante essas janelas;
- ensaio de rollback de flag e versão dentro do canário.

Não ativar flags em tenant real nem consumir a matriz completa do provedor sem
confirmar tenant, janela e orçamento.

## Observações para a próxima sessão

- O worktree já era grande e continha alterações do usuário. Não fazer reset,
  checkout destrutivo ou limpeza ampla.
- Usar sempre `rtk` como prefixo dos comandos.
- Usar bancos de teste UUID descartáveis; não reutilizar nem limpar
  `atendon_test`.
- O wrapper temporário PostgreSQL 16 ainda está em
  `/tmp/atendon-backup-wrapper.q0NYwC/`. Removê-lo somente depois do backup e
  restore pós-deploy.
- O PostgreSQL atual ainda não foi recriado com
  `shared_preload_libraries=pg_stat_statements`.
- O relatório/backup pré-deploy devem ser preservados.

