# Runbook — feature flags e snapshots de deploy

Todas as flags nascem desligadas. Uma migration ou deploy nunca deve ativar uma
flag automaticamente.

## Precedência

A decisão efetiva usa, nesta ordem:

1. kill switch global ligado → `false`;
2. override do workspace;
3. valor global explícito;
4. default persistido (`false`).

As oito chaves permitidas são:

- `conversations_delta_v2`
- `alerts_delivery_v2`
- `evaluation_event_enqueue_v2`
- `scheduling_meet_outbox_v2`
- `ai_deterministic_confirmations_v2`
- `evaluator_payload_redaction_v2`
- `state_tool_gating_v2`
- `compact_prompt_v2`

## Invariantes de segurança

`ai_deterministic_confirmations_v2` e `evaluator_payload_redaction_v2` são
flags não regressivas. A confirmação baseada em evidência transacional e a
redação de PII permanecem sempre ativas, inclusive quando a flag está `OFF`.
Essas flags só podem habilitar projeções, métricas ou validações adicionais;
`OFF` nunca autoriza voltar a confirmação inferida pelo texto do modelo nem
enviar payload bruto ao avaliador.

`state_tool_gating_v2` e `compact_prompt_v2` são flags comportamentais. Quando
`OFF`, preservam respectivamente o conjunto legado de ferramentas e o
prompt/histórico legado. O modo compacto só pode ser promovido após replay com
redução p50 de tokens de entrada de pelo menos 30%, zero regressão crítica e os
gates de regressão/custo existentes.

O workspace pode somente consultar `GET /feature-flags`. As mutações abaixo
exigem uma sessão ROOT e geram `audit_logs`:

- `PATCH /root/feature-flags/:key/global` com `{"enabled":true|false|null}`;
- `PATCH /root/feature-flags/:key/kill-switch` com `{"enabled":true|false}`;
- `PUT /root/workspaces/:tenantId/feature-flags/:key/override` com
  `{"enabled":true|false}`;
- `DELETE /root/workspaces/:tenantId/feature-flags/:key/override`.

`null` no valor global remove a decisão explícita e volta ao default. `DELETE`
remove o override e volta à decisão global/default.

## Fronteira de segurança e fallbacks

As flags controlam a adoção de transportes/otimizações, não os controles de
segurança. Autenticação, RBAC, escopo por `tenant_id`, projeção de recibos na
emissão do alerta, `GET /alerts` sem escrita e `PATCH /alerts/:id/read`
permanecem sempre ativos, independentemente de `alerts_delivery_v2`.

- `conversations_delta_v2=false`: o painel usa
  `GET /conversations/:id/messages`. O endpoint v2 responde `409` com
  `code=FEATURE_FLAG_DISABLED` e informa esse fallback. Ao alternar a decisão
  em runtime, o painel limpa cursores v2 e mescla por ID, sem apagar nem
  duplicar mensagens já exibidas.
- `alerts_delivery_v2=false`: a central continua consultando o histórico
  read-only em `GET /alerts`, com polling fixo e pausa quando a aba está oculta.
  O painel não chama claim nem exibe toasts transitórios. O endpoint
  `POST /alerts/notifications/claim` responde `409` com
  `code=FEATURE_FLAG_DISABLED` e fallback `/alerts`, sem alterar
  `notified_at`.
- `alerts_delivery_v2=true`: claim atômico, toasts e polling adaptativo ficam
  disponíveis. `GET /alerts` continua sem qualquer escrita.

Um ROOT sem membership no workspace continua em `root_read_only`: pode
consultar alertas de audiência do workspace, mas não recebe recibo, não faz
claim e não confirma leitura. Nenhuma combinação de flag amplia essa
permissão.

## Antes do rollout

1. Gere e valide backup/restore em banco isolado.
2. Execute migrations e confirme `/ready`.
3. Defina `DEPLOY_VERSION` com tag, commit ou build imutável. Não use `latest`.
4. Registre o snapshot:

   ```bash
   npm run snapshot:deploy -w @atendon/backend
   ```

5. Guarde o `snapshotHash` no registro do deploy. Repetir o comando com o mesmo
   estado é seguro; reutilizar a mesma versão com estado diferente falha.
6. Confirme em `GET /root/feature-flags` que todas as flags destinadas ao novo
   deploy continuam desligadas.

## Rollout gradual

Ative uma única flag por vez:

1. workspace interno por 24 horas via override;
2. workspace de baixo risco por 48 horas;
3. 25% por 48 horas;
4. 50% por 72 horas;
5. global somente após os estágios anteriores;
6. mantenha flag e fallback disponíveis por pelo menos sete dias.

Monitore somente dimensões agregadas de decisão (`flag`, `source`, `enabled`).
Não inclua tenant, telefone, e-mail, conteúdo ou outro identificador em métricas.

## Rollback e incidente

1. Congele o rollout e preserve logs/métricas sanitizados.
2. Se houver risco amplo, ligue primeiro o kill switch global da flag.
3. Se o risco estiver isolado, remova/desligue apenas o override do workspace.
4. Valide `/ready`, pool, filas e uma conversa sintética sem efeitos reais.
5. Registre novo `DEPLOY_VERSION` e snapshot para qualquer novo artefato.
6. Só remova o kill switch após causa, recuperação e validação confirmadas.

Não faça down migration emergencial. Restaure backup apenas diante de corrupção
ou perda confirmada.
