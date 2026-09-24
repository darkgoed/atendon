# SPEC — Pipeline configurável: múltiplos pipelines, canais, etapas por arrastar

Status: IMPLEMENTADA (backend + painel + testes). Migration 0184 aplicada no banco de teste
(`apps/backend/src/db/migrations/0184_multi_pipelines.sql`). Testes de referência:
backend `tests/pipelines-multi.integration.test.ts` (8 casos: empresa crua, isolamento, reorder,
duplicação, canal→etapa de entrada, move cross-pipeline com automação, 404 cross-tenant, excluir
com substituto); painel `tests/pipeline-{manager,stage-menu,move-between-pipelines}.test.tsx`.

## Modelo (0184)
Empresa (tenant) → canais (`whatsapp_sessions.pipeline_id`, NULL = pipeline padrão) → `pipelines`
(id, tenant_id, name, color, position, is_default, enforce_transitions, archived_at) → `pipeline_stages`
(+ `pipeline_id` NOT NULL, + `automation jsonb` default `{}`) → contatos (`scheduling_leads.pipeline_stage_id`,
+ `origin_session_id` = canal de origem).
- Unicidades por pipeline: nome ativo `(tenant_id,pipeline_id,lower(name))`; etapa preferida por comportamento
  `(tenant_id,pipeline_id,technical_status) WHERE is_default`.
- `pipeline_stages.technical_status` = "comportamento" da etapa. É aplicado ao lead quando ele é MOVIDO
  manualmente (applyStructuredStageEffects já faz). Etapas NOVAS nascem com `em_atendimento` ("Etapa comum").
  `is_default` passou a ser só "etapa preferida para aquele comportamento dentro do pipeline" — NÃO é mais obrigatório.
- Trigger `enforce_scheduling_lead_pipeline_stage` (0184): etapa explícita ativa é respeitada; mudança SÓ de
  status (automação) procura etapa do mesmo comportamento no MESMO pipeline, senão fica onde está; lead novo
  (status novo) entra na PRIMEIRA etapa (menor position) do pipeline do canal de origem (origin_session_id ou
  instagram_session_id) ou do padrão. Lead NUNCA muda de pipeline sozinho.
- SQL helpers: `tenant_default_pipeline(tenant)`, `pipeline_entry_stage(tenant,pipeline)`,
  `pipeline_stage_for_status(tenant,pipeline,status)`.
- Empresa nova: 1 pipeline "Pipeline padrão" + 1 etapa "Primeiro contato" (novo), zero transições.
- Tenants existentes: 1 pipeline "Pipeline principal" (default) com todas as etapas antigas; enforce_transitions herdado.
- Harness: `scripts/migrate-test.ts` adiciona às empresas de TESTE as 9 etapas legadas + grafo, EXCETO quando
  `slug LIKE 'clean-%'`. Testes de "empresa limpa" usam slug `clean-...`.
- `defaultStageId(client, tenantId, status, leadId)` (commercial-journey/service.ts) JÁ resolve no pipeline do lead
  (orquestrador já alterou; call sites já atualizados).

## Contratos de API (backend) — todos com tenant da sessão, nunca do cliente; recurso de outro tenant = 404
Leitura exige `leads.read`; mutações de pipeline/etapa/canal exigem `pipeline.manage`; mover lead exige
`leads.update_status`. Todas sob `requireOrganization` (flag case_organization_v1) como as rotas atuais.

1. `GET /organization/pipelines` → `{ pipelines: PipelineSummary[], channels?: ChannelLink[] }`
   PipelineSummary = `{ id, name, color, position, is_default, enforce_transitions, archived_at, stage_count, lead_count, channel_ids: string[] }`
   (só ativos; ordem position,created_at,id; lead_count ignora deleted_at). `channels` só quando a sessão tem
   `pipeline.manage`: sessões ativas (`archived_at IS NULL`) `{ id, label, channel, phone_number, instagram_username, pipeline_id }`
   (instagram_username = provider_username).
2. `POST /organization/pipelines` body `{ name (1-80), color? (#RRGGBB) }` → 201 `{ pipeline }`. Cria com 1 etapa
   "Primeiro contato" (technical_status novo, is_default true, position 0, cor #64748B). position = max+1. Nome ativo
   duplicado → 409 "Já existe um pipeline com esse nome".
3. `PATCH /organization/pipelines/:pipelineId` body `{ name?, color?, is_default?: true, enforce_transitions?: boolean }`
   (≥1 campo) → `{ pipeline }`. is_default:true troca o padrão (desmarca o anterior na mesma tx). Se o pipeline
   (após a mudança) é o padrão e enforce_transitions mudou, espelhar em `tenants.pipeline_enforce_transitions`.
4. `POST /organization/pipelines/:pipelineId/duplicate` body `{ name? }` → 201 `{ pipeline }`. Nome default
   "<nome> (cópia)" (se colidir, sufixo " 2", " 3"…). Copia etapas ativas (ids NOVOS, mesma ordem, cor,
   capacity_target, technical_status, is_default, automation) e transições remapeadas. NÃO copia leads nem canais.
   is_default do novo = false.
5. `POST /organization/pipelines/:pipelineId/archive` body `{ replacement_pipeline_id? }` → `{ id, archived: true, moved_leads }`.
   409 se for o único pipeline ativo ("A empresa precisa de pelo menos um pipeline"). Se tiver leads (deleted_at IS NULL
   ou não — mova TODOS os leads que apontam para etapas dele) exige replacement ativo do mesmo tenant ≠ ele (400 se
   inválido, 409 "Selecione o pipeline que receberá os contatos" se ausente); leads vão para a etapa de entrada do
   substituto (UPDATE pipeline_stage_id; status inalterado; evento scheduling_lead_events 'pipeline_changed').
   Se era padrão, o substituto (ou o próximo ativo) vira padrão. Canais vinculados → pipeline_id NULL. Etapas dele ficam
   com archived_at=now(). Audit.
6. `PUT /organization/pipelines/order` body `{ pipeline_ids: uuid[] }` = exatamente os ativos do tenant → positions 0..n-1.
   400 se conjunto diferente. → `{ pipelines: PipelineSummary[] }`.
7. `PUT /organization/pipelines/:pipelineId/channels` body `{ session_ids: uuid[] }` → define o conjunto de canais do
   pipeline: sessões listadas passam a apontar para ele (saindo de outro, se estavam); as que apontavam para ele e não
   estão na lista → NULL. Sessões devem ser do tenant e ativas (400). → `{ pipeline_id, session_ids }`. Audit.
8. `PUT /organization/pipelines/:pipelineId/stages/order` body `{ stage_ids: uuid[] }` = exatamente as etapas ATIVAS
   do pipeline (400 se diferente) → positions 0..n-1 sob `SELECT ... FROM pipelines WHERE id FOR UPDATE` (serializa
   reordenações concorrentes). → `{ stages: [{ id, position }] }`.
9. `GET /organization/pipeline?pipeline_id=<uuid>&include_archived=true` (EXISTENTE, evoluído): escopo no pipeline pedido
   (ausente = padrão; de outro tenant/arquivado = 404). Resposta atual + `pipeline: PipelineSummary` e cada stage com
   `pipeline_id` e `automation`; `enforce_transitions` = do pipeline; transitions só do pipeline.
10. `POST /organization/pipeline/stages` (EXISTENTE): body passa a ser `{ pipeline_id?, name, color, technical_status?
    (default em_atendimento), position? (default = fim), capacity_target?, is_default? (default false), automation? }`.
    Nome duplicado no MESMO pipeline → 409; em outro pipeline é permitido.
11. `PATCH /organization/pipeline/stages/:stageId` (EXISTENTE): aceita também `automation`. Mudar technical_status é
    PERMITIDO mesmo com leads/etapa preferida (a etapa perde is_default se mudar de comportamento). Remova os dois 409
    antigos ("Defina outra etapa padrão…", "Não é possível alterar o status técnico…"). setDefaultStage escopo por pipeline.
12. `POST /organization/pipeline/stages/:stageId/duplicate` → 201 `{ stage }`: cópia logo após a original
    (reposiciona as seguintes +1), nome "<nome> (cópia)" com sufixo numérico se colidir, is_default false, sem leads.
13. `POST /organization/pipeline/stages/:stageId/archive` (EXISTENTE): substituta deve ser do MESMO pipeline (400
    senão); NÃO exige mais mesmo technical_status; obrigatória só se lead_count>0; 409 se for a última etapa ativa do
    pipeline ("O pipeline precisa de pelo menos uma etapa"). Se era is_default e há substituta do mesmo comportamento,
    ela herda; senão ninguém.
14. `PUT /organization/pipeline/stages/:stageId/transitions` (EXISTENTE): destinos devem ser do mesmo pipeline (400).
15. `PATCH /organization/pipeline/settings` (EXISTENTE) body `{ enforce_transitions, pipeline_id? }` → atualiza o pipeline
    (padrão se ausente) e espelha no tenant quando for o padrão. Resposta `{ enforce_transitions }` (inalterada).
16. `PATCH /organization/leads/:leadId/stage` (EXISTENTE): etapa alvo pode ser de OUTRO pipeline do tenant (mudança de
    pipeline manual). Regras de sequência (enforce_transitions do pipeline ALVO) só valem dentro do mesmo pipeline;
    cross-pipeline ignora grafo. Evento extra `pipeline_changed` {previous_pipeline_id,new_pipeline_id} quando muda.
    Após o movimento, aplicar `automation` da etapa alvo (ver abaixo). Emitir sinal realtime (abaixo). Bulk move_stage:
    mesma regra de pipeline/automação.
17. Automação por etapa (`automation` jsonb, validado por zod strict): `{ add_tag_ids?: uuid[] (≤20), assign_member_id?: uuid|null }`.
    Executada dentro de moveLeadToStage quando o lead ENTRA na etapa (mudou de etapa): insere tags (só tags ativas do tenant;
    ignora inválidas) e, se assign_member_id é membro ativo, define scheduling_leads.assigned_member_id e
    conversations.assigned_user_id do lead (padrão do bulk assign). Validar ids de tag/membro do tenant no PATCH/POST (400).
18. Realtime: após mover lead (single e bulk), na MESMA transação,
    `SELECT pg_notify('atendon_realtime_changes', $json)` com `{v:1,type:"case.assignment.changed",tenantId,caseId:leadId,
    leadId,entityId:randomUUID(),previousUserId,assignedUserId}` (user ids do responsável antes/depois; pode ser igual) —
    mesmo padrão de commercial-journey/service.ts:230. O painel já revalida o quadro com esse sinal.
19. `GET /scheduling/leads` (scheduling/routes.ts): novo filtro `pipeline_id` (uuid) → `l.pipeline_stage_id IN (SELECT id FROM
    pipeline_stages WHERE tenant_id=$1 AND pipeline_id=$n)`; o JSON `pipeline_stage` ganha `'pipeline_id',stage.pipeline_id`
    (nos 2 selects do arquivo). app.ts: os 3 jsonb `pipeline_stage` (linhas ~1623, ~2013, ~2127) ganham `'pipeline_id',stage.pipeline_id`
    (patch pontual, só isso em app.ts).
20. Pontos de criação de lead com canal conhecido gravam `origin_session_id`: messages/repository.ts (INSERT automatic_lead
    ~728 e ~2384 — use o parâmetro da sessão já presente no CTE), qualification/service.ts ~861 (input.sessionId).
21. Fluxo (robô) `stage_move` (qualification/service.ts ~1217): remover a exigência `s.technical_status=l.status`; exige só
    etapa ativa do tenant; atualiza apenas pipeline_stage_id (status inalterado). Validação de fluxo inalterada.
22. Root preset (root/routes.ts copyWorkspacePreset, options.pipeline): apagar `pipelines` do alvo (cascata nas etapas),
    copiar pipelines do modelo (ids novos, mapa temp) e depois etapas com pipeline_id remapeado + automation; transições
    como hoje. Canais não.
23. dashboard-widgets `pipeline`: incluir `stage.pipeline_id` e `pipeline.name AS pipeline_name` (JOIN pipelines, só ativos)
    ordenando por pipeline.position, stage.position.

## Frontend (apps/panel) — UX
- Cabeçalho de /pipeline: **seletor de pipeline** (botão com bolinha de cor + nome do pipeline ativo + chevron → PopoverMenu com
  a lista: bolinha, nome, contagem de leads, check no ativo; rodapé "Novo pipeline" se pipeline.manage). Sempre visível
  (mesmo com 1 pipeline, mostra o nome — o usuário sempre sabe qual está ativo). Ao lado, **menu ⋯ do pipeline**
  (PopoverMenu + DotsThreeVertical, só pipeline.manage): Renomear / editar, Duplicar, Configurar etapas, Regras de
  movimentação, Canais vinculados, Definir como padrão (se não for), Excluir pipeline. Seleção persistida em localStorage
  por workspace+usuário (`atendon.pipeline.active.v1:<ws>:<user>`) e em `?pipeline=<id>` na URL (URL vence).
- Remove: botão "Configurar" (SlidersHorizontal), toggle "Mostrar todas as etapas" (Eye), projeção legada de colunas
  (`LEGACY_BOARD_PROJECTION`/`DEFAULT_BOARD_STATUS_SET` só para modo legado organizationEnabled===false). Com organização
  ativa, TODAS as etapas do pipeline são colunas, na ordem do backend.
- Nenhum "#10/#20" e nenhum campo "Ordem" na UI. Ordem = arrastar colunas.
- **Coluna**: o cabeçalho ganha alça de arrastar (GripVertical) visível no hover/foco p/ quem tem pipeline.manage — segurar,
  arrastar, soltar reordena; persiste com `PUT /organization/pipelines/:id/stages/order` com update otimista (SWR mutate
  com rollback). Teclado: menu da etapa tem "Mover para a esquerda/direita". Colunas operacionais de IA (Follow-up N/Ligação)
  não arrastam.
- **Menu ⋯ da etapa** (substitui o span aria-hidden atual; só pipeline.manage): Editar etapa (dialog: nome, cor, comportamento,
  meta de capacidade), Alterar cor (paleta de 8 swatches dentro do menu), Automações (dialog: etiquetas ao entrar +
  responsável ao entrar; + movimentos permitidos quando o pipeline estiver em modo governado), Duplicar, Mover para
  esquerda/direita, Excluir etapa (dialog de confirmação; se tem leads, select obrigatório da etapa que recebe os contatos).
- **Nova etapa**: coluna fantasma no fim do quadro "+ Nova etapa" (pipeline.manage) → input inline, Enter cria no fim
  (technical_status em_atendimento, cor alternando a paleta), Esc cancela.
- Comportamento (rótulos da UI para technical_status): novo "Entrada", em_atendimento "Etapa comum", aguardando_resposta
  "Aguardando resposta", qualificado "Qualificado", agendado "Reunião agendada", em_negociacao "Negociação — pede próxima
  ação", proposta_enviada "Proposta — pede próxima ação", follow_up "Follow-up — pede próxima ação", fechado "Ganho — pede
  dados da venda", perdido "Perdido — pede motivo".
- **Cards**: drag entre etapas continua (pipeline-board existente). Corrigir consistência: override otimista por lead
  (`Map<leadId,{pipeline_stage_id,status}>`) aplicado sobre TODAS as fontes (página 1 + extras + páginas por coluna) até a
  revalidação terminar; limpar no fim (sucesso ou erro com rollback). Em 409 ("Lead alterado por outra operação") revalidar e
  mostrar a mensagem. Sem duplicação de card entre fontes (dedupe por id já existe — o override deve valer para a cópia vencedora).
- Filtro de leads: `pipeline_id=<ativo>` sempre na query; filtro de etapa lista só etapas do pipeline ativo.
- **Mover para outro pipeline**: PipelineTransitionDialog ganha select "Pipeline" (default = atual); escolher outro carrega
  `/organization/pipeline?pipeline_id=` e lista todas as etapas ativas dele; envio = mesmo PATCH de etapa. conversation-status-picker
  usa `/organization/pipeline?pipeline_id=${pipelineStage.pipeline_id}` quando houver e oferece o mesmo seletor de pipeline.
- **Canais vinculados** (dialog do pipeline): checklist dos canais (`channels` do GET /organization/pipelines) com rótulo, número/
  @usuário e, se ligado a OUTRO pipeline, o aviso "hoje em <nome>"; salvar = PUT channels. Texto de apoio: "Novos contatos que
  chegarem por estes canais entram na primeira etapa deste pipeline. Canais sem vínculo usam o pipeline padrão."
- **Regras de movimentação** (dialog do pipeline): toggle "Movimentação livre entre etapas" (PATCH pipeline enforce_transitions);
  quando governado, a matriz de movimentos permitidos fica no dialog Automações de cada etapa.
- **Novo / Renomear / Duplicar pipeline**: dialog pequeno (nome + cor). Excluir: confirmação; se tem leads, select obrigatório do
  pipeline que recebe os contatos.
- Padrão salvar → spinner → check → toast (`useSaveFeedback` / `SaveButton` / `SaveToast`) em todo dialog. Ícones SÓ de
  `@/components/icons` (confira os exports antes; se faltar GripVertical/ChevronDown/DotsThreeVertical, adicione re-export de
  lucide-react no padrão do arquivo). Menus = `PopoverMenu` + painel `conversation-action-menu__panel`. Sem nova lib.
- Estado vazio de pipeline novo (1 etapa, 0 leads): coluna "Primeiro contato" + coluna "+ Nova etapa" — nada de exemplos.

## Isolamento (critério de aceite)
Editar/reordenar/arquivar etapas ou automações de um pipeline não altera outro; empresa B recebe 404 em qualquer id da empresa A
(pipeline, etapa, canal, lead); nome igual em pipelines diferentes é permitido.
